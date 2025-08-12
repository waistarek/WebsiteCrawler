// HeaderCrawler/crawlHeaderOnly_cheerio.js
// Zweck: Website rekursiv crawlen und ALLE URLs im HEADER zählen (Links + Assets).
// Ergebnis: pages.csv (pro Seite) + summary.csv (Summen).
//
// Läuft in GitHub Actions ohne Headless-Browser (Cheerio = serverseitiges HTML).
// JS-dynamisch eingefügte Header-Assets sieht er nicht – für viele Seiten reicht das.

// ==================== KONFIGURATION ====================
function toBool(v, def) { return v == null ? def : /^(1|true|yes)$/i.test(String(v)); }
function toInt(v, def)  { return v == null ? def : (isFinite(parseInt(v,10)) ? parseInt(v,10) : def); }

const CONFIG = {
  startUrl: process.env.START_URL || 'https://example.com',             // Start-URL
  maxDepth: toInt(process.env.MAX_DEPTH, 2),                            // Tiefe (0 = nur Startseite)
  maxPages: toInt(process.env.MAX_PAGES, 300),                          // Sicherheitslimit
  sameOriginOnly: toBool(process.env.SAME_ORIGIN_ONLY, true),           // strenger Modus: Schema+Host+Port identisch
  includeSubdomains: toBool(process.env.INCLUDE_SUBDOMAINS, false),     // Subdomains als intern behandeln?
  dedupByUrl: toBool(process.env.DEDUP_BY_URL, true),                   // Duplikate (pro Seite) nach normalisierter URL entfernen
  followFromHeaderOnly: toBool(process.env.FOLLOW_FROM_HEADER_ONLY, true), // Rekursiv nur Header-Links verfolgen (HTML-Ziele)?
  paramIgnore: (process.env.PARAM_IGNORE || 'utm_,gclid,fbclid,mc_,pk_')
                .split(',').map(s => s.trim()).filter(Boolean),         // zu ignorierende Param-Prefixe
  headerSelectors: process.env.HEADER_SELECTORS || 'header, [role="banner"], .header, .site-header', // Header-Kandidaten
  pagesCsv: process.env.PAGES_CSV || 'pages.csv',
  summaryCsv: process.env.SUMMARY_CSV || 'summary.csv',
  userAgent: 'HMF-Header-Crawler/1.1 (+https://example.com)'
};

// ==================== IMPORTS ====================
const fs = require('fs');                  // CSV schreiben
const path = require('path');              // Pfade bauen
const fetch = require('node-fetch');       // HTTP (CommonJS, v2)
const cheerio = require('cheerio');        // HTML parsen

// ==================== HILFSFUNKTIONEN ====================

// absolute URL aus relativem Wert (beachtet Redirects/Basis)
function toAbs(href, base) {
  try { return new URL(href, base).href; } catch { return ''; }
}

// URL normalisieren: Hash weg + ausgewählte Query-Parameter entfernen
function normUrl(u, ignoreList = CONFIG.paramIgnore) {
  if (!u) return '';
  try {
    const url = new URL(u);
    url.hash = ''; // #anker entfernen
    const drop = [];
    url.searchParams.forEach((v,k) => {
      const low = k.toLowerCase();
      if (ignoreList.some(p => low.startsWith(p.toLowerCase()))) drop.push(k);
    });
    drop.forEach(k => url.searchParams.delete(k));
    return url.href;
  } catch {
    return (u || '').split('#')[0];
  }
}

// gehört URL in den Crawl-Scope?
function inScope(urlStr, start, { sameOriginOnly, includeSubdomains }) {
  try {
    const u = new URL(urlStr);
    const s = new URL(start);
    if (sameOriginOnly) return u.origin === s.origin; // exakt gleiche Origin
    if (includeSubdomains) {
      return u.hostname === s.hostname || u.hostname.endsWith('.' + s.hostname);
    }
    return u.hostname === s.hostname;
  } catch { return false; }
}

// HTML-Dokument? (Assets ausfiltern fürs Folgen)
function looksLikeHtml(urlStr) {
  return !/\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|rar|7z|gz|tar|mp4|webm|mp3|wav|ogg|css|js|mjs|woff2?|ttf|otf|eot|json|xml)(\?|$)/i.test(urlStr);
}

// HEAD-Request + Body laden
async function fetchPage(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': CONFIG.userAgent }});
    return res;
  } catch (e) {
    return { ok: false, status: 0, url, error: 'FETCH_ERROR: ' + e.message };
  }
}

// Endung (Dateityp) extrahieren
function getExt(u) {
  try {
    const { pathname } = new URL(u);
    const m = pathname.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

// Ressourcentyp klassifizieren (für Spalten type_*)
function classifyResourceType(href, absUrl) {
  const low = (href || '').toLowerCase();
  // Protokoll-Typen zuerst
  if (low.startsWith('mailto:')) return 'MAIL';
  if (low.startsWith('tel:'))    return 'TEL';
  const proto = (absUrl || href).split(':')[0].toLowerCase();
  if (proto && !['http','https'].includes(proto)) {
    if (proto === 'data') return 'DATA';
    if (proto === 'blob') return 'BLOB';
    if (proto === 'ftp')  return 'FTP';
    return proto.toUpperCase();
  }

  // Dateiendung auswerten
  const ext = getExt(absUrl || href);
  if (/(jpe?g|png|gif|webp)$/i.test(ext)) return 'IMAGE';
  if (ext === 'svg') return 'SVG';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'css') return 'CSS';
  if (ext === 'js' || ext === 'mjs') return 'JS';
  if (/^woff2?$|^ttf$|^otf$|^eot$/i.test(ext)) return 'FONT';
  if (/^(mp4|webm)$/i.test(ext)) return 'VIDEO';
  if (/^(mp3|wav|ogg)$/i.test(ext)) return 'AUDIO';
  if (ext === 'json') return 'JSON';
  if (ext === 'xml')  return 'XML';
  if (ext === 'ico')  return 'ICON';

  // Fallback: HTTP(S) ohne klare Endung → HTML
  if (/^https?:/i.test(absUrl || href)) return 'HTML';

  return 'OTHER';
}

// INTERN/EXTERN (Scope) bestimmen – konsistent zu Scope-Config
function classifyScope(absUrl, startUrl) {
  try {
    const u = new URL(absUrl);
    const s = new URL(startUrl);

    if (CONFIG.sameOriginOnly) {
      return (u.origin === s.origin) ? 'INTERN' : 'EXTERN';
    }
    if (CONFIG.includeSubdomains) {
      const sameOrSub = (u.hostname === s.hostname) || u.hostname.endsWith('.' + s.hostname);
      return sameOrSub ? 'INTERN' : 'EXTERN';
    }
    return (u.hostname === s.hostname) ? 'INTERN' : 'EXTERN';
  } catch {
    return 'OTHER';
  }
}

// `style="background: url(...)"` → URLs extrahieren
function urlsFromStyle(styleValue) {
  if (!styleValue) return [];
  const out = [];
  // findet url("...") / url('...') / url(...)
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
  let m;
  while ((m = re.exec(styleValue)) !== null) {
    const raw = (m[2] || '').trim();
    if (raw) out.push(raw);
  }
  return out;
}

// ==================== HEADER SEITE PARSEN ====================
async function parseHeader(url, startUrl) {
  // 1) Seite laden
  const res = await fetchPage(url);
  const ct  = String(res.headers?.get?.('content-type') || '');
  if (!res.ok || !ct.includes('text/html')) {
    return { pageUrl: res.url || url, rows: [], next: [], error: res.error || `NON_HTML: ${ct}` };
  }
  const html = await res.text();
  const finalUrl = res.url || url;

  // 2) HTML parsen
  const $ = cheerio.load(html);

  // 3) Header-Element bestimmen (erster Treffer)
  const headerCandidates = $(CONFIG.headerSelectors).toArray();
  const headerEl = headerCandidates.length ? headerCandidates[0] : null;
  if (!headerEl) {
    // Kein Header gefunden → keine Header-URLs, aber weitercrawlen (aus Links der ganzen Seite, falls konfiguriert)
    return { pageUrl: finalUrl, rows: [], next: collectNextLinks($, finalUrl, startUrl), error: '' };
  }

  // 4) ALLE URL-Quellen im Header sammeln
  //    Wir gehen den Header-Baum durch und lesen gängige Attribute aus.
  const nodes = $(headerEl).find('*').toArray(); // alle Kinder im Header

  // Kandidaten-Attribute, die URLs enthalten können
  const URL_ATTRS = ['href', 'src', 'poster', 'data']; // Basics
  const rowsRaw = [];

  for (const el of nodes) {
    const $el = $(el);
    const tag = ($el.prop('tagName') || '').toLowerCase();

    // a[href], link[href], etc.
    for (const attr of URL_ATTRS) {
      const val = $el.attr(attr);
      if (val) {
        const abs = toAbs(val, finalUrl);                 // absolute URL bilden
        if (abs) {
          // Label-Text: bei <a> → Text, sonst Tag@Attr
          const label = tag === 'a'
            ? (($el.text() || '').trim().replace(/\s+/g, ' ') || `[${tag}@${attr}]`)
            : `[${tag}@${attr}]`;
          rowsRaw.push({ text: label, raw: val, url: abs });
        }
      }
    }

    // srcset (img/srcset, source/srcset) → enthält mehrere URLs
    const srcset = $el.attr('srcset');
    if (srcset) {
      // Format: "url1 1x, url2 2x" oder "url 480w, url 800w"
      srcset.split(',').forEach(part => {
        const urlPart = (part || '').trim().split(/\s+/)[0]; // nur die URL vor dem Space
        if (urlPart) {
          const abs = toAbs(urlPart, finalUrl);
          if (abs) rowsRaw.push({ text: `[${tag}@srcset]`, raw: urlPart, url: abs });
        }
      });
    }

    // style="...url(...)" → Hintergrundbilder, etc.
    const style = $el.attr('style');
    if (style) {
      for (const u of urlsFromStyle(style)) {
        const abs = toAbs(u, finalUrl);
        if (abs) rowsRaw.push({ text: `[${tag}@style-url]`, raw: u, url: abs });
      }
    }
  }

  // 5) Datensätze anreichern (Typ + Scope bestimmen)
  const enriched = rowsRaw.map(r => {
    const typ   = classifyResourceType(r.raw, r.url);        // Ressourcentyp (IMAGE, PDF, HTML, ...)
    const scope = /^https?:/i.test(r.url) ? classifyScope(r.url, startUrl) : 'OTHER'; // INTERN/EXTERN nur für http(s)
    return { text: r.text, href: r.raw, url: r.url, type: typ, scope };
  });

  // 6) Duplikate innerhalb der Seite (optional) entfernen
  const rows = (() => {
    if (!CONFIG.dedupByUrl) return enriched;
    const m = new Map();
    for (const r of enriched) {
      const key = normUrl(r.url, CONFIG.paramIgnore);
      if (key && !m.has(key)) m.set(key, r); // erste Instanz behalten
    }
    return [...m.values()];
  })();

  // 7) Nächste Seiten bestimmen (für Rekursion)
  //    Standard: nur interne HTML-Ziele AUS DEM HEADER weiterverfolgen.
  let next = [];
  const headerHtmlLinks = rows
    .filter(r => r.type === 'HTML')                          // nur HTML-Dokumente
    .filter(r => r.scope === 'INTERN')                       // nur intern
    .map(r => normUrl(r.url, CONFIG.paramIgnore))            // normalisieren
    .filter(Boolean);

  if (CONFIG.followFromHeaderOnly) {
    next = [...new Set(headerHtmlLinks)];
  } else {
    // alternativ: alle internen HTML-Links der GESAMTEN Seite (nicht nur Header)
    next = collectNextLinks($, finalUrl, startUrl);
  }

  return { pageUrl: finalUrl, rows, next, error: '' };
}

// Hilfsfunktion: alle internen HTML-Links der ganzen Seite sammeln (für Alternativmodus)
function collectNextLinks($, baseUrl, startUrl) {
  const all = $('a[href]').toArray().map(el => $(el).attr('href') || '');
  const abs = all.map(h => toAbs(h, baseUrl));
  const norm = abs.map(u => normUrl(u, CONFIG.paramIgnore)).filter(Boolean);
  const htmlOnly = norm.filter(u => /^https?:/i.test(u) && looksLikeHtml(u));
  const inScopeOnly = htmlOnly.filter(u => inScope(u, startUrl, {
    sameOriginOnly: CONFIG.sameOriginOnly,
    includeSubdomains: CONFIG.includeSubdomains
  }));
  return [...new Set(inScopeOnly)];
}

// ==================== CRAWL-LOGIK ====================
async function crawl() {
  const start = CONFIG.startUrl;
  const queue = [{ url: start, depth: 0 }];   // Warteschlange
  const seen  = new Set();                    // schon gesehene Seiten (normalisiert)
  const pages = [];                           // Ergebnisse pro Seite

  while (queue.length && pages.length < CONFIG.maxPages) {
    const { url, depth } = queue.shift();
    const key = normUrl(url, CONFIG.paramIgnore);
    if (seen.has(key)) continue;              // Seite bereits besucht?
    seen.add(key);

    const data = await parseHeader(url, start);

    // Zähler aufbauen: pro Ressourcentyp und pro Scope
    const typeCounts = data.rows.reduce((a, r) => (a[r.type] = (a[r.type] || 0) + 1, a), {});
    const scopeCounts = data.rows.reduce((a, r) => (a[r.scope] = (a[r.scope] || 0) + 1, a), {});

    pages.push({
      pageUrl: data.pageUrl,
      total: data.rows.length,        // Anzahl Header-URLs (nach Deduplizierung)
      // Für Rückwärtskompatibilität lassen wir "unique" = total (wir deduplizieren bereits)
      unique: data.rows.length,
      types: typeCounts,
      scopes: scopeCounts,
      error: data.error || ''
    });

    // Rekursion (Tiefe beachten)
    if (!data.error && depth < CONFIG.maxDepth) {
      for (const n of data.next) {
        if (!seen.has(n)) queue.push({ url: n, depth: depth + 1 });
      }
    }
  }

  return pages;
}

// ==================== CSV SCHREIBEN ====================
function objToCsvRow(obj) {
  return Object.values(obj).map(v => `"${String(v).replace(/"/g,'""')}"`).join(';');
}

function savePagesCsv(pages, filePath) {
  // Spalten dynamisch: alle vorkommenden Typen & Scopes einsammeln
  const typeSet  = new Set(['HTML','IMAGE','SVG','PDF','CSS','JS','FONT','AUDIO','VIDEO','JSON','XML','MAIL','TEL','DATA','BLOB','FTP','OTHER']);
  const scopeSet = new Set(['INTERN','EXTERN','OTHER']);
  pages.forEach(p => {
    Object.keys(p.types  || {}).forEach(t => typeSet.add(t));
    Object.keys(p.scopes || {}).forEach(s => scopeSet.add(s));
  });

  const typeCols  = [...typeSet].map(t => `type_${t}`);
  const scopeCols = [...scopeSet].map(s => `scope_${s}`);

  const head = ['pageUrl','total','unique', ...typeCols, ...scopeCols, 'error'];
  const rows = [head.join(';')];

  for (const p of pages) {
    const tVals = typeCols.map(c => p.types[c.replace('type_','')] || 0);
    const sVals = scopeCols.map(c => p.scopes[c.replace('scope_','')] || 0);
    const obj = {
      pageUrl: p.pageUrl,
      total: p.total,
      unique: p.unique,
      ...Object.fromEntries(typeCols.map((c,i)=>[c, tVals[i]])),
      ...Object.fromEntries(scopeCols.map((c,i)=>[c, sVals[i]])),
      error: p.error || ''
    };
    rows.push(objToCsvRow(obj));
  }

  fs.writeFileSync(path.resolve(filePath), rows.join('\n'), 'utf8');
}

function saveSummaryCsv(pages, filePath) {
  const sum = (fn) => pages.reduce((a,p)=> a + fn(p), 0);

  // Alle Keys einsammeln
  const typeSet  = new Set();
  const scopeSet = new Set();
  pages.forEach(p => {
    Object.keys(p.types  || {}).forEach(t => typeSet.add(t));
    Object.keys(p.scopes || {}).forEach(s => scopeSet.add(s));
  });

  const rows = [];
  rows.push(['metric','value'].join(';'));

  rows.push(objToCsvRow({ metric: 'pages', value: pages.length }));
  rows.push(objToCsvRow({ metric: 'header_urls_total', value: sum(p=>p.total) }));
  rows.push(objToCsvRow({ metric: 'header_urls_unique', value: sum(p=>p.unique) }));

  // Summen je Ressourcentyp
  for (const t of [...typeSet]) {
    const v = sum(p => p.types[t] || 0);
    rows.push(objToCsvRow({ metric: `type_${t}`, value: v }));
  }
  // Summen je Scope
  for (const s of [...scopeSet]) {
    const v = sum(p => p.scopes[s] || 0);
    rows.push(objToCsvRow({ metric: `scope_${s}`, value: v }));
  }

  fs.writeFileSync(path.resolve(filePath), rows.join('\n'), 'utf8');
}

// ==================== START ====================
(async () => {
  console.log('Starte HEADER-Crawl (ALLE URLs) von:', CONFIG.startUrl);
  console.log(`maxDepth=${CONFIG.maxDepth} maxPages=${CONFIG.maxPages} sameOriginOnly=${CONFIG.sameOriginOnly} includeSubdomains=${CONFIG.includeSubdomains}`);
  console.log(`followFromHeaderOnly=${CONFIG.followFromHeaderOnly}`);

  const pages = await crawl();

  const sum = (fn) => pages.reduce((a,p)=>a+fn(p),0);
  console.log('Seiten:', pages.length);
  console.log('Header-URLs total:', sum(p=>p.total));

  savePagesCsv(pages, CONFIG.pagesCsv);
  saveSummaryCsv(pages, CONFIG.summaryCsv);

  console.log('CSV gespeichert:', path.resolve(CONFIG.pagesCsv), 'und', path.resolve(CONFIG.summaryCsv));
})();
