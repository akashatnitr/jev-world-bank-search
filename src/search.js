// Retrieval: BM25 (SQLite FTS5, sub-millisecond, used on every keystroke),
// semantic (bge embeddings + Vectorize), fused with reciprocal rank fusion,
// optionally filtered to domains, optionally re-ranked by Jev.
import { db } from './db.js';
import { embed, queryVectors } from './cf.js';
import { jev, noul } from './jev.js';

const STOP = new Set(('a an and are as at be by for from has have how in is it its of on or that the this to was were what when where which who why will with does do did can could should would about into than then there their these those our your my me we you they them i not no yes'.split(' ')));

function ftsQuery(text, { prefixLast = true } = {}) {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t));
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${prefixLast && i === terms.length - 1 && t.length >= 3 ? '*' : ''}`).join(' OR ');
}

const ftsStmt = db.prepare(`
  SELECT f.chunk_id, snippet(chunks_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet, bm25(chunks_fts, 1.0, 0.4) AS rank
  FROM chunks_fts f WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`);

export function lexical(text, limit = 40) {
  const fq = ftsQuery(text);
  if (!fq) return [];
  try { return ftsStmt.all(fq, limit); } catch { return []; }
}

export async function semantic(text, topK = 40) {
  const [vec] = await embed([text]);
  return queryVectors(vec, topK);
}

const chunkStmt = db.prepare(`SELECT c.id, c.document_id, c.page, c.text, d.title, d.country, d.doc_date, d.doc_type, d.pdf_url, d.source_url
  FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?`);
const domainsOf = db.prepare(`SELECT d.id, d.name, a.name area FROM document_domains dd JOIN domains d ON d.id = dd.domain_id
  JOIN domains a ON a.id = d.parent_id WHERE dd.document_id = ? ORDER BY dd.score DESC`);
const docsInDomains = (ids) => new Set(db.prepare(
  `SELECT document_id FROM document_domains WHERE domain_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.document_id));

const domainCache = new Map();
export function domainsForDoc(docId) {
  if (!domainCache.has(docId)) domainCache.set(docId, domainsOf.all(docId));
  return domainCache.get(docId);
}
export function clearDomainCache() { domainCache.clear(); }

function hydrate(id, extra = {}) {
  const c = chunkStmt.get(id);
  if (!c) return null;
  return { ...c, domains: domainsForDoc(c.document_id), ...extra };
}

// Reciprocal rank fusion over the two rankings.
export async function hybrid(text, { limit = 10, domainIds, lexicalOnly = false, maxPerDoc = 3 } = {}) {
  const lex = lexical(text, 50);
  let sem = [];
  if (!lexicalOnly) { try { sem = await semantic(text, 50); } catch (e) { console.warn('semantic search failed:', e.message); } }
  const K = 60, scores = new Map(), snippets = new Map();
  lex.forEach((r, i) => { scores.set(r.chunk_id, (scores.get(r.chunk_id) || 0) + 1 / (K + i)); snippets.set(r.chunk_id, r.snippet); });
  sem.forEach((r, i) => scores.set(r.id, (scores.get(r.id) || 0) + 1 / (K + i)));
  const allowed = domainIds?.length ? docsInDomains(domainIds) : null;

  const perDoc = new Map(), out = [];
  for (const [id, score] of [...scores].sort((a, b) => b[1] - a[1])) {
    const docId = id.slice(0, id.indexOf(':'));
    if (allowed && !allowed.has(docId)) continue;
    if ((perDoc.get(docId) || 0) >= maxPerDoc) continue;
    const h = hydrate(id, { score, snippet: snippets.get(id), via: [lex.some((r) => r.chunk_id === id) && 'bm25', sem.some((r) => r.id === id) && 'vector'].filter(Boolean) });
    if (!h) continue;
    perDoc.set(docId, (perDoc.get(docId) || 0) + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

// Jev scores each passage for usefulness in one call (docs.typesafe.ai cookbook:
// "Classifying RAG passages"); code decides what reaches the answering model.
export async function jevRerank(question, passages, { keep = 8, min = 0.35 } = {}) {
  if (!passages.length) return passages;
  const state = { question, passages: Object.fromEntries(passages.map((p, i) => [`p${i}`, `${p.title} (p.${p.page}): ${p.text}`])) };
  const questions = Object.fromEntries(passages.map((_, i) => [`p${i}`, noul(
    `Does \`passages.p${i}\` contain information that helps answer \`question\`?`,
    { true: 'It states facts, figures, findings or arguments relevant to the question', false: 'It is off-topic or only shares keywords' },
  )]));
  const ans = await jev(state, questions);
  const scored = passages.map((p, i) => ({ ...p, relevance: +ans[`p${i}`].noul.toFixed(3) }));
  const good = scored.filter((p) => p.relevance >= min).sort((a, b) => b.relevance - a.relevance);
  return (good.length ? good : scored.sort((a, b) => b.relevance - a.relevance).slice(0, 3)).slice(0, keep);
}
