// Per-document pipeline: liteparse -> chunks (+FTS) -> domain routing -> embeddings -> Vectorize.
import { LiteParse } from '@llamaindex/liteparse';
import { config } from './config.js';
import { db, q, tx } from './db.js';
import { routeDocument } from './domains.js';
import { embed, upsertVectors } from './cf.js';
import { jev, choice } from './jev.js';

const parser = new LiteParse({
  outputFormat: 'json',
  ocrEnabled: false,            // World Bank publications carry a text layer
  maxPages: config.maxPagesPerDoc,
  continueOnPageError: true,
  quiet: true,
});

const CHUNK = 1100;
const OVERLAP = 150;

function cleanPage(text) {
  return text.replace(/Public Disclosure (Authorized|Restricted)/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

export function chunkPage(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= CHUNK) return flat.length >= 80 ? [flat] : [];
  const out = [];
  let start = 0;
  while (start < flat.length) {
    let end = Math.min(start + CHUNK, flat.length);
    if (end < flat.length) {
      const cut = flat.lastIndexOf('. ', end);
      if (cut > start + CHUNK * 0.6) end = cut + 1;
    }
    const piece = flat.slice(start, end).trim();
    if (piece.length >= 80) out.push(piece);
    if (end >= flat.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out;
}

// Uploads often arrive with a filename for a title. Code proposes spans of
// consecutive lines from the first page; Jev picks the one that is the title.
async function inferTitle(firstPage) {
  const lines = firstPage.split('\n').map((l) => l.trim()).filter((l) => l.length > 2 && /[a-z]/i.test(l)).slice(0, 14);
  const spans = new Map();
  for (let i = 0; i < lines.length; i++) {
    for (let n = 1; n <= 5 && i + n <= lines.length; n++) {
      const text = lines.slice(i, i + n).join(' ').replace(/\s+/g, ' ');
      if (text.length >= 12 && text.length <= 200) spans.set(`s${spans.size}`, text);
    }
  }
  if (!spans.size) return null;
  const ans = await jev({ first_page: lines.join('\n') }, {
    title: choice('Which option is the complete main title of the document on `first_page`, including its subtitle if any, without report labels like "Final Report" or project codes?',
      Object.fromEntries([...spans].map(([k, v]) => [k, v]))),
  });
  const pick = spans.get(ans.title.choice);
  if (!pick || ans.title.confidence < 0.3) return null;
  return pick === pick.toUpperCase() ? pick.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : pick;
}

export async function parseDocument(doc) {
  const result = await parser.parse(doc.pdf_path);
  const pages = result.pages.map((p) => ({ page: p.pageNum ?? p.page, text: cleanPage(p.text || '') }));
  const chars = pages.reduce((s, p) => s + p.text.length, 0);
  if (chars < 500) throw new Error('no usable text layer (scanned PDF?)');
  if (doc.doc_type === 'Upload' && !/\s/.test(doc.title)) {
    const title = await inferTitle(pages[0]?.text || '').catch(() => null);
    if (title) { db.prepare('UPDATE documents SET title = ? WHERE id = ?').run(title, doc.id); doc.title = title; }
  }

  const insChunk = db.prepare('INSERT OR REPLACE INTO chunks (id, document_id, page, ord, text, embedded) VALUES (?, ?, ?, ?, ?, 0)');
  const insFts = db.prepare('INSERT INTO chunks_fts (text, title, chunk_id) VALUES (?, ?, ?)');
  let n = 0;
  tx(() => {
    db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(doc.id);
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
    for (const p of pages) {
      chunkPage(p.text).forEach((text, i) => {
        const id = `${doc.id}:${p.page}:${i}`;
        insChunk.run(id, doc.id, p.page, i, text);
        insFts.run(text, doc.title, id);
        n++;
      });
    }
    db.prepare("UPDATE documents SET pages = ?, status = 'parsed', error = NULL WHERE id = ?").run(result.totalPages ?? pages.length, doc.id);
  });
  return { pages, chunks: n, totalPages: result.totalPages ?? pages.length };
}

export function loadPages(docId) {
  const rows = db.prepare('SELECT page, group_concat(text, \' \') text FROM (SELECT page, text FROM chunks WHERE document_id = ? ORDER BY page, ord) GROUP BY page ORDER BY page').all(docId);
  return rows;
}

export async function indexDocument(doc) {
  const chunks = db.prepare('SELECT id, page, text FROM chunks WHERE document_id = ? AND embedded = 0').all(doc.id);
  for (let i = 0; i < chunks.length; i += 200) {
    const batch = chunks.slice(i, i + 200);
    const vecs = await embed(batch.map((c) => `${doc.title}\n${c.text}`));
    await upsertVectors(batch.map((c, j) => ({
      id: c.id, values: vecs[j], metadata: { doc_id: doc.id, page: c.page },
    })));
    const mark = db.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?');
    tx(() => batch.forEach((c) => mark.run(c.id)));
  }
  q.setStatus.run('indexed', null, doc.id);
  return chunks.length;
}

// Full pipeline for one document (used by uploads; batch ingest staggers the steps).
export async function ingestDocument(docId, log = () => {}) {
  const doc = q.doc.get(docId);
  try {
    log({ step: 'parse', status: 'running' });
    const t0 = Date.now();
    const parsed = await parseDocument(doc);
    log({ step: 'parse', status: 'done', ms: Date.now() - t0, pages: parsed.totalPages, chunks: parsed.chunks });

    log({ step: 'route', status: 'running' });
    const routing = await routeDocument(doc, parsed.pages);
    log({ step: 'route', status: 'done', routing });

    log({ step: 'index', status: 'running' });
    const t2 = Date.now();
    const n = await indexDocument(doc);
    log({ step: 'index', status: 'done', ms: Date.now() - t2, vectors: n });
    return { routing, chunks: parsed.chunks };
  } catch (e) {
    q.setStatus.run('failed', e.message, docId);
    log({ step: 'error', status: 'failed', error: e.message });
    throw e;
  }
}
