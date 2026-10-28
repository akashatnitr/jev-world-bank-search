import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, ROOT } from './config.js';
import { db, q } from './db.js';
import { getTree, routeQuery, docDomains, invalidateTree } from './domains.js';
import { lexical, hybrid, domainsForDoc, clearDomainCache } from './search.js';
import { runAgent } from './agent.js';
import { ingestDocument } from './pipeline.js';
import { ensureIndex } from './cf.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const sse = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// Batch ingest runs in another process and grows the tree; refresh caches periodically.
setInterval(() => { invalidateTree(); clearDomainCache(); }, 15_000).unref();

app.get('/api/stats', (req, res) => {
  const r = db.prepare(`SELECT
    (SELECT count(*) FROM documents) documents,
    (SELECT count(*) FROM documents WHERE status = 'indexed') indexed_docs,
    (SELECT count(*) FROM documents WHERE status = 'failed') failed,
    (SELECT count(*) FROM chunks) chunks,
    (SELECT count(*) FROM chunks WHERE embedded = 1) vectors,
    (SELECT count(*) FROM (SELECT DISTINCT document_id, page FROM chunks)) pages,
    (SELECT count(*) FROM domains WHERE parent_id IS NULL) areas,
    (SELECT count(*) FROM domains WHERE parent_id IS NOT NULL) domains,
    (SELECT count(*) FROM documents WHERE routing LIKE '%"method":"jev"%') routed_jev,
    (SELECT count(*) FROM documents WHERE routing LIKE '%"method":"glm"%') routed_glm`).get();
  res.json({ ...r, vector_index: config.vectorIndex, llm: config.llmModel, router: config.jevModel, threshold: config.domainThreshold });
});

app.get('/api/domains', (req, res) => res.json(getTree()));

app.get('/api/domains/:id', (req, res) => {
  const d = q.domain.get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'not found' });
  const ids = d.parent_id ? [d.id] : q.children.all(d.id).map((c) => c.id);
  const docs = ids.length ? db.prepare(`SELECT DISTINCT doc.id, doc.title, doc.country, doc.doc_date, doc.doc_type, doc.pages, dd.score, dd.method
    FROM document_domains dd JOIN documents doc ON doc.id = dd.document_id
    WHERE dd.domain_id IN (${ids.map(() => '?').join(',')}) GROUP BY doc.id ORDER BY dd.score DESC, doc.doc_date DESC`).all(...ids) : [];
  res.json({ ...d, parent: d.parent_id ? q.domain.get(d.parent_id) : null, children: d.parent_id ? [] : q.children.all(d.id), documents: docs });
});

app.get('/api/documents', (req, res) => {
  const kw = req.query.q ? `%${req.query.q}%` : null;
  const rows = db.prepare(`SELECT id, title, country, doc_date, doc_type, pages, status, routing FROM documents
    ${kw ? 'WHERE title LIKE ? OR country LIKE ?' : ''} ORDER BY rowid DESC`).all(...(kw ? [kw, kw] : []));
  res.json(rows.map((r) => ({ ...r, routing: r.routing ? JSON.parse(r.routing) : null, domains: docDomains(r.id) })));
});

app.get('/api/documents/:id', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json({ ...d, routing: d.routing ? JSON.parse(d.routing) : null, domains: docDomains(d.id),
    chunks: db.prepare('SELECT count(*) n FROM chunks WHERE document_id = ?').get(d.id).n });
});

app.get('/pdf/:id', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d?.pdf_path || !fs.existsSync(d.pdf_path)) return res.status(404).end();
  res.type('application/pdf').sendFile(d.pdf_path);
});

// ---- live sources while typing ----

// BM25 only: answers in ~1ms, fired on every keystroke.
app.get('/api/live/lexical', (req, res) => {
  const text = String(req.query.q || '').slice(0, 300);
  const t = performance.now();
  const hits = lexical(text, 60);
  const byDoc = new Map();
  for (const h of hits) {
    const docId = h.chunk_id.slice(0, h.chunk_id.indexOf(':'));
    if (byDoc.has(docId)) { byDoc.get(docId).hits++; continue; }
    const c = db.prepare('SELECT c.page, d.id, d.title, d.country, d.doc_date FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?').get(h.chunk_id);
    if (c) byDoc.set(docId, { ...c, chunk_id: h.chunk_id, snippet: h.snippet, hits: 1, domains: domainsForDoc(docId) });
  }
  res.json({ ms: +(performance.now() - t).toFixed(2), sources: [...byDoc.values()].slice(0, 8) });
});

// Vector + BM25 fusion and Jev domain routing, fired after a short pause in typing.
app.get('/api/live/semantic', async (req, res) => {
  const text = String(req.query.q || '').slice(0, 300);
  if (text.trim().length < 4) return res.json({ sources: [], route: { domains: [] } });
  const t = Date.now();
  try {
    const [hits, route] = await Promise.all([
      hybrid(text, { limit: 8, maxPerDoc: 1 }),
      routeQuery(text).catch((e) => ({ domains: [], error: e.message })),
    ]);
    res.json({
      ms: Date.now() - t, route,
      sources: hits.map((h) => ({ id: h.document_id, chunk_id: h.id, title: h.title, page: h.page, country: h.country,
        doc_date: h.doc_date, via: h.via, domains: h.domains, snippet: h.snippet || h.text.slice(0, 220) + '…' })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- agentic answer ----

app.post('/api/ask', async (req, res) => {
  const { question, history, domainIds } = req.body || {};
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });
  const emit = sse(res);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const t = Date.now();
  try {
    await runAgent({ question: question.trim(), history, domainIds }, emit, ac.signal);
    emit('done', { ms: Date.now() - t });
  } catch (e) {
    if (!ac.signal.aborted) { console.error(e); emit('error', { message: e.message }); }
  }
  res.end();
});

// ---- add a document (PDF upload or URL) ----

let routingLock = Promise.resolve();
app.post('/api/documents', express.raw({ type: 'application/pdf', limit: '40mb' }), async (req, res) => {
  const emit = sse(res);
  try {
    let buf, title, sourceUrl = null;
    if (Buffer.isBuffer(req.body)) {
      buf = req.body;
      title = decodeURIComponent(String(req.headers['x-filename'] || 'Uploaded document')).replace(/\.pdf$/i, '');
    } else if (req.body?.url) {
      emit('step', { step: 'download', status: 'running' });
      const r = await fetch(req.body.url, { signal: AbortSignal.timeout(90_000) });
      if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
      sourceUrl = req.body.url;
      title = req.body.title || decodeURIComponent(new URL(req.body.url).pathname.split('/').pop()).replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ');
      emit('step', { step: 'download', status: 'done', bytes: buf.length });
    } else throw new Error('send a PDF body or {url}');
    if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');

    const id = 'up_' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    if (q.doc.get(id)?.status === 'indexed') { emit('exists', { id }); return res.end(); }
    const dest = path.join(config.dataDir, 'pdfs', `${id}.pdf`);
    fs.writeFileSync(dest, buf);
    db.prepare(`INSERT OR REPLACE INTO documents (id, title, doc_type, source_url, pdf_url, pdf_path, abstract, status)
      VALUES (?, ?, 'Upload', ?, ?, ?, ?, 'downloaded')`).run(id, title, sourceUrl, sourceUrl, dest, req.body?.abstract || null);
    emit('created', { id, title });

    // Routing is serialized so concurrent uploads see each other's new domains.
    const run = routingLock.then(() => ingestDocument(id, (ev) => emit('step', ev)));
    routingLock = run.catch(() => {});
    await run;
    invalidateTree(); clearDomainCache();
    emit('done', { id, domains: docDomains(id) });
  } catch (e) {
    emit('error', { message: e.message });
  }
  res.end();
});

await ensureIndex();
app.listen(config.port, '0.0.0.0', () => console.log(`World Bank agentic RAG on http://localhost:${config.port}`));
