// Zweck: Website rekursiv crawlen und pro Seite die Links in HEADER / MAIN (zwischen Header & Footer) / FOOTER zählen.
// Aufruf lokal (wird aber durch GitHub Actions gestartet):
//   node crawlHeaderMainFooter_cheerio.js https://example.com
//
// WICHTIG: Kein Headless-Browser – wir lesen serverseitiges HTML (ohne JS-Ausführung).
// Vorteil: Läuft überall online; Nachteil: JS-generierte Links werden nicht gesehen.
//
// ===================== EINSTELLUNGEN (CONFIG) =====================

// Basis-Config mit sinnvollen Defaults
const CONFIG = {
  startUrl: process.argv[2] || 'https://example.com', // Start-URL kann per CLI gesetzt werden
  maxDepth: 2,                    // 0 = nur Startseite, 1 = + deren Links, usw.
  maxPages: 300,                  // Sicherheitslimit: max. Seiten insgesamt
  sameOriginOnly: true,           // nur exakt gleiche Origin (Schema+Host+Port)?
  includeSubdomains: false,       // falls sameOriginOnly=false: Subdomains erlauben?
  dedupByUrl: true,               // doppelte Ziel-URLs je Seite zusammenführen (ohne #)
  paramIgnore: ['utm_', 'gclid', 'fbclid', 'mc_', 'pk_'], // Query-Parameter-Prefixe ignorieren
  outputCsv: 'crawl_results_cheerio.csv',                 // Ergebnisdatei
  headerSelectors: 'header, [role="banner"], .header, .site-header',        // Header-Kandidaten
  footerSelectors: 'footer, [role="contentinfo"], .footer, .site-footer',   // Footer-Kandidaten
  userAgent: 'HMF-Crawler/1.0 (+https://example.com)'
};

// === Eingaben aus ENV (vom GitHub-Workflow) erlauben ===
const env = process.env;
const toBool = (v, def) => (v == null ? def : /^(1|true|yes)$/i.test(String(v)));
const toInt  = (v, def) => (v == null ? def : (isFinite(parseInt(v,10)) ? parseInt(v,10) : def));

CONFIG.startUrl         = env.START_URL         || CONFIG.startUrl;
CONFIG.maxDepth         = toInt(env.MAX_DEPTH,          CONFIG.maxDepth);
CONFIG.maxPages         = toInt(env.MAX_PAGES,          CONFIG.maxPages);
CONFIG.sameOriginOnly   = toBool(env.SAME_ORIGIN_ONLY,  CONFIG.sameOriginOnly);
CONFIG.includeSubdomains= toBool(env.INCLUDE_SUBDOMAINS,CONFIG.includeSubdomains);
CONFIG.dedupByUrl       = toBool(env.DEDUP_BY_URL,      CONFIG.dedupByUrl);
CONFIG.outputCsv        = env.OUTPUT_CSV        || CONFIG.outputCsv;
if (env.PARAM_IGNORE) {
  // Kommagetrennt, z. B. "utm_,gclid,fbclid"
  CONFIG.paramIgnore = env.PARAM_IGNORE.split(',').map(s => s.trim()).filter(Boolean);
}

// ===================== AB HIER CODE =====================
const fs = require('fs');                 // Datei schreiben (CSV)
const path = require('path');             // Pfade bauen
const fetch = require('node-fetch');      // HTTP-Requests (v2, CommonJS)
const cheerio = require('cheerio');       // HTML parsen (jQuery-ähnlich)

// relative URL -> absolute URL (beachtet Redirects/Basis)
function toAbs(href, base) {
  try { return new URL(href, base).href; } catch { return ''; }
}

// URL normalisieren (Hash weg + ausgewählte Query-Parameter entfernen)
function normUrl(u, ignoreList = CONFIG.paramIgnore) {
  if (!u) return '';
  try {
    const url = new URL(u);
    url.hash = ''; // #anker entfernen
    const drop = [];
    url.searchParams.forEach((v,k) => {
      const kLow = k.toLowerCase();
      if (ignoreList.some(p => kLow.startsWith(p.toLowerCase()))) drop.push(k); // Prefix-Match (utm_)
    });
    drop.forEach(k => url.searchParams.delete(k));
    return url.href;
  } catch {
    return (u || '').split('#')[0];
  }
}

// Scope prüfen: Darf die URL gecrawlt werden?
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

// einfache Heuristik: Sieht nach HTML aus? (keine Assets)
function looksLikeHtml(urlStr) {
  return !/\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|rar|7z|gz|tar|mp4|mp3|wav|ogg|css|js)(\?|$)/i.test(urlStr);
}

// Eine Seite laden und auswerten (ohne JS)
async function processPage(url, startUrl) {
  // 1) Seite abrufen
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': CONFIG.userAgent }});
  } catch (e) {
    return { pageUrl: url, error: 'FETCH_ERROR: ' + e.message };
  }

  // 2) Nur HTML weiter verarbeiten
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return { pageUrl: res.url || url, error: 'NON_HTML: ' + contentType };
  }

  const html = await res.text();
  const base = res.url || url; // endgültige URL nach Redirects

  // 3) HTML parsen
  const $ = cheerio.load(html);

  // 4) Header & Footer bestimmen
  const headerCandidates = $(CONFIG.headerSelectors).toArray();
  const footerCandidates = $(CONFIG.footerSelectors).toArray();
  const headerEl = headerCandidates.length ? headerCandidates[0] : null;                        // erster Header
  const footerEl = footerCandidates.length ? footerCandidates[footerCandidates.length - 1] : null; // letzter Footer

  // 5) Alle Links sammeln
  const allLinks = $('a[href]').toArray();

  // 6) Helper: liegt ein <a> innerhalb eines Containers?
  function isInside(el, container) {
    if (!el || !container) return false;
    let cur = el.parent;                 // gehe im Baum nach oben
    while (cur) {
      if (cur === container) return true;
      cur = cur.parent;
    }
    return false;
  }

  // 7) In Bereiche aufteilen
  const headerLinks = [];
  const footerLinks = [];
  const mainLinks   = [];

  for (const el of allLinks) {
    if (headerEl && isInside(el, headerEl)) { headerLinks.push(el); continue; }
    if (footerEl && isInside(el, footerEl)) { footerLinks.push(el); continue; }
    mainLinks.push(el); // alles andere gilt als „Main“
  }

  // 8) Datensätze + Deduplizierung je Bereich
  function makeRecords(list) {
    const recs = list.map(el => {
      const $a = $(el);
      const href = ($a.attr('href') || '').trim();                // Original-HREF
      const abs  = toAbs(href, base);                             // absolute URL
      const text = ($a.text() || '').trim().replace(/\s+/g,' ');  // Linktext
      // Typ: grobe Klassifizierung
      const typ = (() => {
        const low = href.toLowerCase();
        if (low.startsWith('tel:'))    return 'TEL';
        if (low.startsWith('mailto:')) return 'MAIL';
        if (/\.pdf(\?|$)/i.test(low))  return 'PDF';
        try {
          const uh = new URL(abs).hostname;     // Host des Links
          const sh = new URL(startUrl).hostname;// Host der Start-URL
          return (uh === sh) ? 'INTERN' : 'EXTERN';
        } catch { return 'UNBEKANNT'; }
      })();
      return { text, href, url: abs, typ };
    });

    if (!CONFIG.dedupByUrl) return { all: recs, unique: recs };

    const m = new Map();                           // Map für „ein Ziel = 1x“
    for (const r of recs) {
      const key = normUrl(r.url, CONFIG.paramIgnore); // URL ohne # und ohne ignorierte Parameter
      if (key && !m.has(key)) m.set(key, r);      // erste Instanz behalten
    }
    return { all: recs, unique: [...m.values()] };
  }

  const headerData = makeRecords(headerLinks);
  const mainData   = makeRecords(mainLinks);
  const footerData = makeRecords(footerLinks);

  // 9) Nächste Crawl-Kandidaten: interne http(s)-Links aus allen Bereichen
  const nextCandidates = [...new Set(
    allLinks
      .map(el => toAbs($(el).attr('href') || '', base))
      .filter(u => /^https?:\/\//i.test(u))
      .map(u => normUrl(u, CONFIG.paramIgnore))
      .filter(u => u && looksLikeHtml(u) && inScope(u, startUrl, {
        sameOriginOnly: CONFIG.sameOriginOnly,
        includeSubdomains: CONFIG.includeSubdomains
      }))
  )];

  return {
    pageUrl: base,
    header: headerData,
    main:   mainData,
    footer: footerData,
    nextCandidates
  };
}

// 10) Crawl-Steuerung (FIFO-Queue, bewusst einfach gehalten)
async function crawlSite() {
  const start = CONFIG.startUrl;
  const queue = [{ url: start, depth: 0 }];      // Start in die Warteschlange
  const seen  = new Set();                       // bereits besuchte Seiten (normalisiert)
  const out   = [];                              // Ergebnisse pro Seite

  while (queue.length && out.length < CONFIG.maxPages) {
    const { url, depth } = queue.shift();
    const norm = normUrl(url, CONFIG.paramIgnore);
    if (seen.has(norm)) continue;                // Seite schon gesehen → weiter
    seen.add(norm);

    const data = await processPage(url, start);
    if (data.error) {
      // Bei Fehler trotzdem eine Zeile erzeugen (mit 0-Werten)
      out.push({
        pageUrl: data.pageUrl,
        headerCounts:{total:0,unique:0,types:{}},
        mainCounts:{total:0,unique:0,types:{}},
        footerCounts:{total:0,unique:0,types:{}},
        error: data.error
      });
      continue;
    }

    // Zählen pro Bereich
    const count = (arr) => arr.length;
    const group = (arr) => arr.reduce((a,r)=> (a[r.typ]=(a[r.typ]||0)+1, a), {});
    const headerCounts = { total: count(data.header.all), unique: count(data.header.unique), types: group(data.header.unique) };
    const mainCounts   = { total: count(data.main.all),   unique: count(data.main.unique),   types: group(data.main.unique) };
    const footerCounts = { total: count(data.footer.all), unique: count(data.footer.unique), types: group(data.footer.unique) };

    out.push({ pageUrl: data.pageUrl, headerCounts, mainCounts, footerCounts });

    // Nächste Seiten planen (Tiefe beachten)
    if (depth < CONFIG.maxDepth) {
      for (const n of data.nextCandidates) {
        if (!seen.has(n)) queue.push({ url: n, depth: depth + 1 });
      }
    }
  }
  return out;
}

// 11) CSV schreiben
function saveCsv(results, filePath) {
  const head = [
    'pageUrl',
    'header_total','header_unique','header_types',
    'main_total','main_unique','main_types',
    'footer_total','footer_unique','footer_types',
    'error'
  ];
  const rows = [head.join(';')];

  for (const r of results) {
    const hTypes = JSON.stringify(r.headerCounts.types || {});
    const mTypes = JSON.stringify(r.mainCounts.types || {});
    const fTypes = JSON.stringify(r.footerCounts.types || {});
    const line = [
      r.pageUrl || '',
      r.headerCounts.total || 0, r.headerCounts.unique || 0, hTypes,
      r.mainCounts.total   || 0, r.mainCounts.unique   || 0, mTypes,
      r.footerCounts.total || 0, r.footerCounts.unique || 0, fTypes,
      r.error || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';');
    rows.push(line);
  }

  const abs = path.resolve(filePath);
  fs.writeFileSync(abs, rows.join('\n'), 'utf8');
  console.log('CSV gespeichert:', abs);
}

// 12) Start
(async () => {
  console.log('Starte Crawl (cheerio) von:', CONFIG.startUrl);
  console.log(`maxDepth=${CONFIG.maxDepth}, maxPages=${CONFIG.maxPages}, sameOriginOnly=${CONFIG.sameOriginOnly}, includeSubdomains=${CONFIG.includeSubdomains}`);
  const results = await crawlSite();

  // kleine Summen ausgeben
  const sum = (arr, get) => arr.reduce((a, r) => a + get(r), 0);
  console.log('Seiten:', results.length);
  console.log('Header-Links gesamt (unique pro Seite):', sum(results, r => r.headerCounts.unique));
  console.log('Main-Links   gesamt (unique pro Seite):', sum(results, r => r.mainCounts.unique));
  console.log('Footer-Links gesamt (unique pro Seite):', sum(results, r => r.footerCounts.unique));

  saveCsv(results, CONFIG.outputCsv);
})();
