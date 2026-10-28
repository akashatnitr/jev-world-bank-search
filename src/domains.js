// The domain graph: a tree of areas -> domains that grows as documents arrive.
//
// Routing a document:
//   1. Jev answers one noul per area and per domain in a single fan-out call
//      ("is this document substantially about <domain>?").
//   2. A domain is accepted when its noul >= domainThreshold and its parent
//      area's noul >= areaThreshold (keeps tags consistent with the tree).
//      A document may take several domains.
//   3. If nothing clears the threshold, GLM flash proposes new domain(s),
//      attaching them under an existing area or a new one.
import { config } from './config.js';
import { db, q, tx } from './db.js';
import { jev, noul } from './jev.js';
import { chatStream, parseJson } from './cf.js';

const MAX_TAGS = 4;
const FANOUT_LIMIT = 200; // above this many questions, walk the tree in two calls

let treeCache = null;
export function invalidateTree() { treeCache = null; }

export function getTree() {
  if (treeCache) return treeCache;
  const counts = new Map(db.prepare('SELECT domain_id, count(*) n FROM document_domains GROUP BY domain_id').all()
    .map((r) => [r.domain_id, r.n]));
  const areas = q.areas.all().map((a) => {
    const domains = q.children.all(a.id).map((d) => ({ ...d, docs: counts.get(d.id) || 0 }));
    return { ...a, domains, docs: domains.reduce((s, d) => s + d.docs, 0) };
  });
  treeCache = areas;
  return areas;
}

function treeForPrompt(tree) {
  if (!tree.length) return '(empty: no areas or domains exist yet)';
  return tree.map((a) => `AREA "${a.name}": ${a.description}\n` +
    a.domains.map((d) => `  - DOMAIN "${d.name}": ${d.description}`).join('\n')).join('\n');
}

// Asks Jev about every area and domain at once; returns scored candidates.
async function scoreAgainstTree(state, subject, tree, { signal } = {}) {
  if (!tree.length) return { areas: new Map(), domains: [] };
  const areaQ = (a) => noul({
    area: { name: a.name, description: a.description },
    question: `Is the ${subject} in \`state\` substantially about the topic described in \`area\`?`,
  });
  const domQ = (a, d) => noul({
    domain: { name: d.name, description: d.description, part_of: a.name },
    question: `Is the ${subject} in \`state\` substantially about the topic described in \`domain\`?`,
  }, {
    true: `The ${subject} directly addresses this domain's topic`,
    false: `The ${subject} only mentions it in passing or is about something else`,
  });

  const total = tree.length + tree.reduce((s, a) => s + a.domains.length, 0);
  const areaScores = new Map();
  let candidates = [];

  if (total <= FANOUT_LIMIT) {
    const questions = {};
    for (const a of tree) {
      questions[`a${a.id}`] = areaQ(a);
      for (const d of a.domains) questions[`d${d.id}`] = domQ(a, d);
    }
    const ans = await jev(state, questions, { signal });
    for (const a of tree) {
      areaScores.set(a.id, ans[`a${a.id}`].noul);
      for (const d of a.domains) candidates.push({ domain: d, area: a, score: ans[`d${d.id}`].noul });
    }
  } else {
    const aq = Object.fromEntries(tree.map((a) => [`a${a.id}`, areaQ(a)]));
    const aAns = await jev(state, aq, { signal });
    for (const a of tree) areaScores.set(a.id, aAns[`a${a.id}`].noul);
    const open = tree.filter((a) => areaScores.get(a.id) >= config.areaThreshold);
    const dq = {};
    for (const a of open) for (const d of a.domains) dq[`d${d.id}`] = domQ(a, d);
    if (Object.keys(dq).length) {
      const dAns = await jev(state, dq, { signal });
      for (const a of open) for (const d of a.domains) candidates.push({ domain: d, area: a, score: dAns[`d${d.id}`].noul });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return { areas: areaScores, domains: candidates };
}

export function documentState(doc, pages) {
  const body = pages.map((p) => p.text).join('\n').replace(/Public Disclosure Authorized/g, '')
    .replace(/\s+/g, ' ').trim();
  return {
    title: doc.title,
    country_or_region: doc.country || 'unspecified',
    document_type: doc.doc_type || 'unspecified',
    abstract: (doc.abstract || '').slice(0, 2500) || 'none',
    excerpt: body.slice(0, doc.abstract ? 2000 : 4000),
  };
}

async function proposeDomains(state, tree, nearMisses) {
  const sys = `You maintain the domain taxonomy for a World Bank document library.
The taxonomy is a tree: broad AREAS (e.g. "Climate & Environment") each containing specific DOMAINS
(e.g. "Climate Adaptation & Resilience"). A new document did not fit any existing domain well enough.
Propose 1 or 2 NEW domains that capture what the document is substantially about.
Rules:
- A domain is a reusable thematic field that many future documents could share. Never a country, a single project, or a document title.
- Domain names: 2-5 words, Title Case. Descriptions: one specific sentence defining scope (what is in, what is out).
- Do not duplicate or trivially rename an existing domain.
- Put each domain under an existing AREA when one fits; otherwise create a new AREA (broad, 1-4 words) with a one-sentence description.
- Decide quickly: think briefly, do not deliberate over alternatives at length.
- Reply with JSON only:
{"domains":[{"name":"...","description":"...","area":"<existing or new area name>","area_description":"<only when the area is new>"}]}`;
  const user = `CURRENT TAXONOMY:\n${treeForPrompt(tree)}\n\nCLOSEST EXISTING DOMAINS (Jev probability, below threshold ${config.domainThreshold}):\n` +
    (nearMisses.length ? nearMisses.map((c) => `- ${c.area.name} > ${c.domain.name}: ${c.score.toFixed(2)}`).join('\n') : '- none') +
    `\n\nDOCUMENT:\n${JSON.stringify(state, null, 1)}`;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let reasoning = 0;
      const out = await chatStream([{ role: 'system', content: sys }, { role: 'user', content: user }], {
        maxTokens: 8000, temperature: 0.3, signal: AbortSignal.timeout(120_000),
        onEvent: (e) => { if (e.type === 'reasoning') reasoning += e.text.length; },
      });
      const parsed = parseJson(out.message.content || '');
      const list = (parsed.domains || []).filter((d) => d?.name && d?.description && d?.area).slice(0, 2);
      if (list.length) return list;
      lastErr = new Error(`no domains in reply (finish=${out.finish}, reasoning ${reasoning} chars)`);
    } catch (e) { lastErr = e; }
    console.warn(`   GLM domain proposal attempt ${attempt + 1} failed: ${lastErr.message}`);
  }
  throw new Error(`GLM did not return usable domains: ${lastErr?.message}`);
}

const norm = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

function createDomains(proposals, docId) {
  return tx(() => {
    const created = [];
    for (const p of proposals) {
      let area = q.areas.all().find((a) => norm(a.name) === norm(p.area));
      if (!area) {
        const r = db.prepare('INSERT INTO domains (name, description, parent_id, created_by, created_for) VALUES (?, ?, NULL, ?, ?)')
          .run(p.area.trim(), (p.area_description || `Documents about ${p.area}.`).trim(), 'glm', docId);
        area = q.domain.get(r.lastInsertRowid);
        created.push({ ...area, kind: 'area' });
      }
      let dom = q.children.all(area.id).find((d) => norm(d.name) === norm(p.name));
      if (!dom) {
        const r = db.prepare('INSERT INTO domains (name, description, parent_id, created_by, created_for) VALUES (?, ?, ?, ?, ?)')
          .run(p.name.trim(), p.description.trim(), area.id, 'glm', docId);
        dom = q.domain.get(r.lastInsertRowid);
        created.push({ ...dom, kind: 'domain', area: area.name });
      }
      created.push({ ...dom, kind: 'tag', area: area.name });
    }
    invalidateTree();
    return created;
  });
}

const tag = db.prepare('INSERT OR REPLACE INTO document_domains (document_id, domain_id, score, method) VALUES (?, ?, ?, ?)');

// Routes one document into the graph. Must run sequentially across documents,
// since each routing can grow the tree the next one sees.
export async function routeDocument(doc, pages) {
  const state = documentState(doc, pages);
  const tree = getTree();
  const t0 = Date.now();
  const { areas, domains } = await scoreAgainstTree(state, 'document', tree);
  const jevMs = Date.now() - t0;

  const accepted = domains.filter((c) => c.score >= config.domainThreshold &&
    (areas.get(c.area.id) ?? 1) >= config.areaThreshold).slice(0, MAX_TAGS);

  const routing = {
    jev_ms: jevMs,
    threshold: config.domainThreshold,
    top: domains.slice(0, 6).map((c) => ({ id: c.domain.id, path: `${c.area.name} > ${c.domain.name}`, score: +c.score.toFixed(3) })),
  };

  if (accepted.length) {
    tx(() => { for (const c of accepted) tag.run(doc.id, c.domain.id, c.score, 'jev'); });
    invalidateTree();
    routing.method = 'jev';
    routing.tags = accepted.map((c) => ({ id: c.domain.id, path: `${c.area.name} > ${c.domain.name}`, score: +c.score.toFixed(3) }));
  } else {
    const t1 = Date.now();
    const proposals = await proposeDomains(state, tree, domains.slice(0, 3));
    const created = createDomains(proposals, doc.id);
    tx(() => { for (const c of created.filter((x) => x.kind === 'tag')) tag.run(doc.id, c.id, 1, 'glm'); });
    invalidateTree();
    routing.method = 'glm';
    routing.glm_ms = Date.now() - t1;
    routing.created = created.filter((c) => c.kind !== 'tag').map((c) => ({ id: c.id, kind: c.kind, name: c.name, area: c.area }));
    routing.tags = created.filter((c) => c.kind === 'tag').map((c) => ({ id: c.id, path: `${c.area} > ${c.name}`, score: 1 }));
  }
  db.prepare("UPDATE documents SET routing = ?, status = 'routed' WHERE id = ?").run(JSON.stringify(routing), doc.id);
  return routing;
}

// Which domains is a user's question about? Used live while typing and by the agent.
export async function routeQuery(question, { signal, threshold = 0.5 } = {}) {
  const tree = getTree();
  const t0 = Date.now();
  const { domains } = await scoreAgainstTree({ question }, 'question', tree, { signal });
  return {
    ms: Date.now() - t0,
    domains: domains.filter((c) => c.score >= threshold).slice(0, 5)
      .map((c) => ({ id: c.domain.id, name: c.domain.name, area: c.area.name, score: +c.score.toFixed(3) })),
  };
}

export function docDomains(docId) {
  return db.prepare(`SELECT d.id, d.name, a.name area, dd.score, dd.method FROM document_domains dd
    JOIN domains d ON d.id = dd.domain_id JOIN domains a ON a.id = d.parent_id
    WHERE dd.document_id = ? ORDER BY dd.score DESC`).all(docId);
}
