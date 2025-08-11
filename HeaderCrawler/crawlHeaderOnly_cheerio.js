// crawlHeaderOnly_cheerio.js
// Zweck: Website rekursiv crawlen und NUR die Links im HEADER zählen.
// Ergebnis: 2 CSVs -> pages.csv (pro Seite) + summary.csv (Summen aller Seiten).
//
// Aufruf (durch GitHub Actions gesteuert):
//   node crawlHeaderOnly_cheerio.js
//
// ⚠️ Kein Headless-Browser – wir lesen serverseitiges HTML (ohne JS).
//    JS-generierte Links im Header sieht der Crawler nicht. Für viele Seiten reicht das.

// ------------------- KONFIG mit sinnvollen Defaults -------------------
const CONFIG = {
  startUrl: process.env.START_URL || 'https://example.com', // Start-URL
  maxDepth: toInt(process.env.MAX_DEPTH, 2),                // 0 = nur Startseite
  maxPages: toInt(process.env.MAX_PAGES, 300),              // Sicherheitslimit
  sameOriginOnly: toBool(process.env.SAME_ORIGIN_ONLY, true),   // nur gleiche Origin?
  includeSubdomains: toBool(process.env.INCLUDE_SUBDOMAINS, false), // Subdomains zulassen?
  dedupByUrl: toBool(process.env.DEDUP_BY_URL, true),       // Duplikate pro Seite zusammenfassen (ohne #, ohne Param.)
  // Nur Header-Links verfolgen? true = NUR aus dem Header, false = alle internen Links der Seite
  followFromHeaderOnly: toBool(process.env.FOLLOW_FROM_HEADER_ONLY, true),
  // Query-Parameter, die bei der Normalisierung ignoriert werden (Prefix-Regel)
  paramIgnore: (process.env.PARAM_IGNORE || 'utm_,gclid,fbclid,mc_,pk_')
                .split(',').map(s => s.trim()).filter(Boolean),
  // Selektoren für Header (erster Treffer gilt als Header)
  headerSelectors: process.env.HEADER_SELECTORS || 'header, [role="banner"], .header, .site-header',
  // Dateinamen der Ausgaben
  pagesCsv: process.env.PAGES_CSV || 'pages.csv',
  summaryCsv: process.env.SUMMARY_CSV || 'summary.csv',
  userAgent: 'HMF-Header-Crawler/1.0 (+https://example.com)'
};

// ------------------- Hilfsfunktionen (allgemein) ---------------------
function toBool(v, def) { return v == null ? def : /^(1|true|yes)$/i.test(String(v)); }
function toInt(v, def)  { return v == null ? def : (isFinite(parseInt(v,10)) ? parseInt(v,10) : def); }

const fs = require('fs');                 // Dateien schreiben
const path = require('path');             // Pfade
const fetch = require('node-fetch');      // HTTP (v2, CommonJS)
const cheerio = require('cheerio');       // HTML parsen

// relative URL -> absolute (beachtet Redirects/Basis)
function toAbs(href, base) {
  try { return new URL(href, base).href; } catch { return ''; }
}

// URL normalisieren: Hash weg + definierte Param-Prefixe entfernen
function normUrl(u, ignoreList = CONFIG.paramIgnore) {
  if (!u) return '';
  try {
    const url = new URL(u);
    url.hash = '';
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

// In Scope? (steuert, wohin wir rekursiv folgen dürfen)
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

// Sieht nach HTML-Dokument aus? (keine Assets)
function looksLikeHtml(urlStr) {
  return !/\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|rar|7z|gz|tar|mp4|mp3|wav|ogg|css|js)(\?|$)/i.test(urlStr);
}

// ------------------- Eine Seite laden & auswerten --------------------
async function fetchPage(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': CONFIG.userAgent }});
    return res;
  } catch (e) {
    return { ok: false, status: 0, url, error: 'FETCH_ERROR: ' + e.message };
  }
}

function classifyType(href, absUrl, startUrl) {
  // Einfache Typ-Klassifizierung für Header-Links
  const low = (href || '').toLowerCase();
  if (low.startsWith('tel:'))    return 'TEL';
  if (low.startsWith('mailto:')) return 'MAIL';
  if (/\.pdf(\?|$)/i.test(low))  return 'PDF';
  const proto = (absUrl || href).split(':')[0].toLowerCase();
  if (proto && !['http','https'].includes(proto)) return proto.toUpperCase(); // z.B. 'JAVASCRIPT'
  try {
    const uh = new URL(absUrl).hostname;
    const sh = new URL(startUrl).hostname;
    return (uh === sh) ? 'INTERN' : 'EXTERN';
  } catch { return 'UNBEKANNT'; }
}

function countTypes(rows) {
  // Zählt wie viele pro Typ in rows vorkommen
  return rows.reduce((a, r) => (a[r.typ] = (a[r.typ] || 0) + 1, a), {});
}

// ------------------- Seite parsen: NUR Header ------------------------
async function parseHeader(url, startUrl) {
  // 1) Seite holen
  const res = await fetchPage(url);
  if (!res.ok || !String(res.headers?.get?.('content-type') || '').includes('text/html')) {
    return { pageUrl: res.url || url, rows: [], next: [], error: res.error || 'NON_HTML' };
  }

  const html = await res.text();
  const finalUrl = res.url || url;       // endgültige URL nach Redirect
  const $ = cheerio.load(html);          // HTML in DOM-Struktur umwandeln

  // 2) Header bestimmen: erster Treffer aus Selektoren
  const headerCandidates = $(CONFIG.headerSelectors).toArray(); // mögliche Header
  const headerEl = headerCandidates.length ? headerCandidates[0] : null;

  // 3) Links im Header sammeln
  const headerLinks = headerEl ? $(headerEl).find('a[href]').toArray() : [];

  // 4) Datensätze bauen (Text, URL, Typ)
  const rowsRaw = headerLinks.map(el => {
    const $a = $(el);
    const href = ($a.attr('href') || '').trim();      // Original-href
    const abs  = toAbs(href, finalUrl);               // absolute URL
    const text = ($a.text() || '').trim().replace(/\s+/g,' '); // sichtbarer Text
    const typ  = classifyType(href, abs, startUrl);   // Typ bestimmen
    return { text, href, url: abs, typ };
  });

  // 5) Duplikate optional raus (gleiches Ziel, normalisiert)
  const rows = (() => {
    if (!CONFIG.dedupByUrl) return rowsRaw;
    const m = new Map();
    for (const r of rowsRaw) {
      const key = normUrl(r.url, CONFIG.paramIgnore);
      if (key && !m.has(key)) m.set(key, r);         // erste Instanz behalten
    }
    return [...m.values()];
  })();

  // 6) Nächste Seiten bestimmen
  //    Standard: wir folgen NUR internen Header-Links (Navigation).
  //    Optional: alle internen Links der Seite (wenn FOLLOW_FROM_HEADER_ONLY=false).
  let nextCandidates = [];
  if (CONFIG.followFromHeaderOnly) {
    nextCandidates = rows
      .map(r => r.url)
      .map(u => normUrl(u, CONFIG.paramIgnore))
      .filter(u => /^https?:\/\//i.test(u) && looksLikeHtml(u) && inScope(u, startUrl, {
        sameOriginOnly: CONFIG.sameOriginOnly,
        includeSubdomains: CONFIG.includeSubdomains
      }));
  } else {
    // alle <a href> der gesamten Seite holen und intern filtern
    const allLinks = $('a[href]').toArray();
    nextCandidates = [...new Set(
      allLinks
        .map(el => toAbs($(el).attr('href') || '', finalUrl))
        .map(u => normUrl(u, CONFIG.paramIgnore))
        .filter(u => /^https?:\/\//i.test(u) && looksLikeHtml(u) && inScope(u, startUrl, {
          sameOriginOnly: CONFIG.sameOriginOnly,
          includeSubdomains: CONFIG.includeSubdomains
        }))
    )];
  }

  return { pageUrl: finalUrl, rows, next: [...new Set(nextCandidates)], error: '' };
}

// ------------------- Crawl-Steuerung (FIFO-Queue) -------------------
async function crawl() {
  const start = CONFIG.startUrl;
  const queue = [{ url: start, depth: 0 }];  // Start-Job
  const seen  = new Set();                   // bereits besuchte Seiten (normalisiert)
  const pages = [];                          // Ergebnisse pro Seite

  while (queue.length && pages.length < CONFIG.maxPages) {
    const { url, depth } = queue.shift();
    const key = normUrl(url, CONFIG.paramIgnore);
    if (seen.has(key)) continue;             // schon gesehen? weiter
    seen.add(key);

    const data = await parseHeader(url, start);

    // Seite protokollieren (auch bei Fehlern)
    const types = countTypes(data.rows);
    pages.push({
      pageUrl: data.pageUrl,
      total: data.rows.length,
      unique: data.rows.length, // rows sind ggf. schon dedupliziert
      types,
      error: data.error || ''
    });

    // Nächste Seiten planen (Tiefe prüfen)
    if (!data.error && depth < CONFIG.maxDepth) {
      for (const n of data.next) {
        if (!seen.has(n)) queue.push({ url: n, depth: depth + 1 });
      }
    }
  }

  return pages;
}

// ------------------- CSV-Helfer ------------------------------------
function objToCsvRow(obj) {
  return Object.values(obj).map(v => `"${String(v).replace(/"/g,'""')}"`).join(';');
}

function savePagesCsv(pages, filePath) {
  // dynamische Spalten für Typen (damit alle vorkommenden Typen berücksichtigt werden)
  const allTypes = new Set(['INTERN','EXTERN','MAIL','TEL','PDF','JAVASCRIPT','UNBEKANNT']);
  pages.forEach(p => Object.keys(p.types || {}).forEach(t => allTypes.add(t)));

  const head = ['pageUrl','total','unique', ...[...allTypes].map(t => `type_${t}`), 'error'];
  const rows = [head.join(';')];

  for (const p of pages) {
    const typeCols = [...allTypes].map(t => p.types[t] || 0);
    const obj = {
      pageUrl: p.pageUrl,
      total: p.total,
      unique: p.unique,
      ...Object.fromEntries([...allTypes].map((t,i) => [`type_${t}`, typeCols[i]])),
      error: p.error || ''
    };
    rows.push(objToCsvRow(obj));
  }
  fs.writeFileSync(path.resolve(filePath), rows.join('\n'), 'utf8');
}

function saveSummaryCsv(pages, filePath) {
  // Summen über alle Seiten
  const sum = (fn) => pages.reduce((a,p) => a + fn(p), 0);
  const allTypes = new Set();
  pages.forEach(p => Object.keys(p.types || {}).forEach(t => allTypes.add(t)));

  const totalPages = pages.length;
  const totalLinks = sum(p => p.total);
  const totalUnique = sum(p => p.unique);

  const typeTotals = Object.fromEntries(
    [...allTypes].map(t => [t, sum(p => p.types[t] || 0)])
  );

  const head = ['metric','value'];
  const rows = [head.join(';')];

  rows.push(objToCsvRow({ metric: 'pages', value: totalPages }));
  rows.push(objToCsvRow({ metric: 'header_links_total', value: totalLinks }));
  rows.push(objToCsvRow({ metric: 'header_links_unique', value: totalUnique }));
  for (const [t, v] of Object.entries(typeTotals)) {
    rows.push(objToCsvRow({ metric: `type_${t}`, value: v }));
  }

  fs.writeFileSync(path.resolve(filePath), rows.join('\n'), 'utf8');
}

// ------------------- Start -----------------------------------------
(async () => {
  console.log('Starte HEADER-Crawl von:', CONFIG.startUrl);
  console.log(`maxDepth=${CONFIG.maxDepth} maxPages=${CONFIG.maxPages} sameOriginOnly=${CONFIG.sameOriginOnly} includeSubdomains=${CONFIG.includeSubdomains}`);
  console.log(`followFromHeaderOnly=${CONFIG.followFromHeaderOnly}`);

  const pages = await crawl();

  // kleine Konsole-Zusammenfassung
  const sum = (fn) => pages.reduce((a,p)=>a+fn(p),0);
  console.log('Seiten:', pages.length);
  console.log('Header-Links total:', sum(p=>p.total));
  console.log('Header-Links unique:', sum(p=>p.unique));

  // CSVs schreiben
  savePagesCsv(pages, CONFIG.pagesCsv);
  saveSummaryCsv(pages, CONFIG.summaryCsv);

  console.log('CSV gespeichert:', path.resolve(CONFIG.pagesCsv), 'und', path.resolve(CONFIG.summaryCsv));
})();
