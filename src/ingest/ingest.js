// Batch ingest of downloaded PDFs. Parsing and routing run in document order
// (routing must be sequential: every document may grow the domain tree the
// next one is routed against); embedding/upserts run concurrently behind it.
// Resumable: re-running picks up whatever status each document reached.
import { db, q } from '../db.js';
import { ensureIndex } from '../cf.js';
import { config } from '../config.js';
import { parseDocument, indexDocument, loadPages } from '../pipeline.js';
import { routeDocument } from '../domains.js';

const created = await ensureIndex();
console.log(created ? `created Vectorize index ${config.vectorIndex}` : `using Vectorize index ${config.vectorIndex}`);

const pending = db.prepare("SELECT * FROM documents WHERE status IN ('downloaded','parsed','routed') ORDER BY rowid").all();
console.log(`${pending.length} documents to process`);

const indexing = new Set();
const MAX_INDEXING = 4;
async function startIndex(doc) {
  while (indexing.size >= MAX_INDEXING) await Promise.race(indexing);
  const p = indexDocument(doc)
    .then((n) => console.log(`   indexed ${n} vectors  ${doc.title.slice(0, 60)}`))
    .catch((e) => { q.setStatus.run('failed', `index: ${e.message}`, doc.id); console.log(`   index failed ${doc.id}: ${e.message}`); })
    .finally(() => indexing.delete(p));
  indexing.add(p);
}

let i = 0;
for (const doc of pending) {
  i++;
  try {
    let pages;
    if (doc.status === 'downloaded') {
      const r = await parseDocument(doc);
      pages = r.pages;
      console.log(`[${i}/${pending.length}] parsed ${r.totalPages}p ${r.chunks} chunks  ${doc.title.slice(0, 70)}`);
    }
    if (doc.status === 'downloaded' || doc.status === 'parsed') {
      pages ||= loadPages(doc.id);
      const r = await routeDocument(doc, pages);
      const tags = r.tags.map((t) => `${t.path} (${t.score.toFixed(2)})`).join('; ');
      console.log(`   ${r.method === 'jev' ? 'JEV' : 'GLM+'} ${tags}${r.created?.length ? `  [new: ${r.created.map((c) => c.name).join(', ')}]` : ''}`);
    }
    await startIndex(q.doc.get(doc.id));
  } catch (e) {
    q.setStatus.run('failed', e.message, doc.id);
    console.log(`[${i}/${pending.length}] FAILED ${doc.id}: ${e.message}`);
  }
}
await Promise.all(indexing);

const s = db.prepare('SELECT status, count(*) n FROM documents GROUP BY status').all();
const d = db.prepare('SELECT (SELECT count(*) FROM domains WHERE parent_id IS NULL) areas, (SELECT count(*) FROM domains WHERE parent_id IS NOT NULL) domains, (SELECT count(*) FROM chunks) chunks').get();
console.log('status:', s, d);
