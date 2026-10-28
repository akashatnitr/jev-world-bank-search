// Pulls World Bank publications (Documents & Reports API, the document store
// behind data.worldbank.org/worldbank.org) across a spread of themes and
// downloads their PDFs. Usage: node src/ingest/fetch-docs.js [target=140]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, q } from '../db.js';

const TARGET = Number(process.argv[2] || 140);
const MAX_BYTES = 25 * 1024 * 1024;
const PDF_DIR = path.join(config.dataDir, 'pdfs');
fs.mkdirSync(PDF_DIR, { recursive: true });

// Seed queries only spread the corpus across themes; domains are discovered
// later by Jev/GLM, never taken from these strings.
const THEMES = [
  'climate change adaptation', 'renewable energy transition', 'learning poverty education',
  'health systems universal coverage', 'extreme poverty measurement', 'public debt sustainability',
  'inflation monetary policy', 'agriculture food security', 'water supply sanitation',
  'gender equality women employment', 'digital development broadband', 'trade competitiveness exports',
  'urban development housing', 'social protection cash transfers', 'fragility conflict violence',
  'financial inclusion banking', 'jobs labor market informality', 'transport infrastructure roads',
  'pandemic preparedness covid-19', 'governance public sector procurement', 'migration remittances',
  'disaster risk management', 'biodiversity forests natural capital', 'private sector investment climate',
];

function wdsUrl(qterm, rows) {
  const p = new URLSearchParams({
    format: 'json', rows: String(rows), qterm,
    majdocty_exact: 'Publications & Research', lang_exact: 'English', strdate: '2019-01-01',
    fl: 'id,docty,display_title,pdfurl,docdt,count,abstracts,url',
  });
  return `https://search.worldbank.org/api/v3/wds?${p}`;
}

const insert = db.prepare(`INSERT OR IGNORE INTO documents
  (id, title, doc_type, country, doc_date, abstract, topic, source_url, pdf_url, pdf_path, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloaded')`);

async function download(url, dest) {
  const res = await fetch(url.replace(/^http:/, 'https:'), { redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too large');
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

const have = () => db.prepare('SELECT count(*) n FROM documents').get().n;
const perTheme = Math.ceil(TARGET / THEMES.length) + 1;

const candidates = [];
for (const theme of THEMES) {
  const res = await fetch(wdsUrl(theme, perTheme * 3));
  const json = await res.json();
  const docs = Object.entries(json.documents || {})
    .filter(([k, v]) => k !== 'facets' && v.pdfurl && v.display_title)
    .slice(0, perTheme * 2)
    .map(([, v]) => ({ ...v, theme }));
  candidates.push(docs);
  console.log(`${theme}: ${docs.length} candidates`);
}

// Round-robin across themes so a short run still covers all of them.
const queue = [];
for (let i = 0; candidates.some((c) => c[i]); i++) for (const c of candidates) if (c[i]) queue.push(c[i]);

const seen = new Set();
let cursor = 0;
async function worker() {
  while (have() < TARGET && cursor < queue.length) {
    const d = queue[cursor++];
    if (seen.has(d.id) || q.doc.get(d.id)) continue;
    seen.add(d.id);
    const dest = path.join(PDF_DIR, `${d.id}.pdf`);
    try {
      const bytes = await download(d.pdfurl, dest);
      const abstract = typeof d.abstracts === 'object' ? d.abstracts['cdata!'] : d.abstracts;
      insert.run(d.id, d.display_title.replace(/\.pdf$/i, '').trim(), d.docty || null, d.count || null,
        (d.docdt || '').slice(0, 10), abstract || null, d.theme, d.url || null, d.pdfurl, dest);
      console.log(`[${have()}/${TARGET}] ${(bytes / 1e6).toFixed(1)}MB ${d.display_title.slice(0, 80)}`);
    } catch (e) {
      console.log(`skip ${d.id}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`done: ${have()} documents`);
