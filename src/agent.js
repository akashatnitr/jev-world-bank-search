// Agentic RAG: Jev routes the question and grades evidence; GLM flash plans
// tool calls and writes the answer; Jev then checks each citation.
import { db } from './db.js';
import { chatStream } from './cf.js';
import { jev, noul } from './jev.js';
import { routeQuery, getTree } from './domains.js';
import { hybrid, jevRerank, domainsForDoc } from './search.js';

const MAX_TURNS = 4;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_documents',
      description: 'Hybrid (BM25 + vector) search over World Bank document passages, re-ranked for relevance. Use specific queries; call several times for multi-part or comparative questions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for' },
          domain: { type: 'string', description: 'Optional domain name to restrict the search to (see list_domains)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_domains',
      description: 'Show the domain tree (areas > domains) with document counts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description: 'List documents (id, title, country, date), optionally within a domain or matching a title/country keyword.',
      parameters: {
        type: 'object',
        properties: { domain: { type: 'string' }, keyword: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: 'Read the full text of one page of a document, to get context around a passage.',
      parameters: {
        type: 'object',
        properties: { doc_id: { type: 'string' }, page: { type: 'integer' } },
        required: ['doc_id', 'page'],
      },
    },
  },
];

const SYSTEM = `You are the research assistant for a library of World Bank publications.
Answer ONLY from the numbered sources you are given or retrieve with tools. Each source is a passage from a named document and page.
How to work:
- You already have initial evidence. If it is enough, answer directly. If the question has several parts, compares things, or the evidence is thin, call search_documents (more than once if useful) before answering.
- Cite every factual sentence with source numbers in square brackets, like [2] or [1][4]. Never invent a source number.
- If the sources do not contain the answer, say so plainly and state what the library does cover.
- Be concise and specific: lead with the direct answer, then supporting detail; use short paragraphs or bullets; keep numbers exactly as written in the sources.`;

function findDomain(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const a of getTree()) {
    if (a.name.toLowerCase() === n) return a.domains.map((d) => d.id);
    const d = a.domains.find((x) => x.name.toLowerCase() === n || x.name.toLowerCase().includes(n));
    if (d) return [d.id];
  }
  return null;
}

export async function runAgent({ question, history = [], domainIds }, emit, signal) {
  const sources = [];
  const register = (passages) => passages.map((p) => {
    const existing = sources.find((s) => s.id === p.id);
    if (existing) return existing;
    const s = { n: sources.length + 1, id: p.id, document_id: p.document_id, title: p.title, page: p.page,
      country: p.country, doc_date: p.doc_date, pdf_url: p.pdf_url, source_url: p.source_url,
      text: p.text, relevance: p.relevance, domains: p.domains ?? domainsForDoc(p.document_id) };
    sources.push(s);
    emit('source', s);
    return s;
  });
  const fmt = (list) => list.map((s) => `[${s.n}] ${s.title} — p.${s.page}${s.country ? ` (${s.country}, ${s.doc_date?.slice(0, 4)})` : ''}\n${s.text}`).join('\n\n');

  // 1. Jev routes the question into the domain graph while retrieval runs.
  const t0 = Date.now();
  const [route, initial] = await Promise.all([
    routeQuery(question).catch((e) => ({ ms: 0, domains: [], error: e.message })),
    hybrid(question, { limit: 14, domainIds }),
  ]);
  emit('route', route);

  // 2. Jev grades the passages; only useful ones reach GLM.
  const rerankArgs = { passages: initial.length };
  emit('tool', { name: 'jev_rerank', status: 'running', args: rerankArgs });
  const graded = await jevRerank(question, initial, { keep: 8 }).catch(() => initial.slice(0, 8));
  register(graded);
  emit('tool', { name: 'jev_rerank', status: 'done', args: rerankArgs, result: `${graded.length}/${initial.length} passages kept`, ms: Date.now() - t0 });

  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `Question: ${question}\n\nJev routed this question to domains: ${route.domains.map((d) => `${d.area} > ${d.name} (${d.score})`).join('; ') || 'none above threshold'}\n\nInitial evidence:\n${fmt(sources)}`,
    },
  ];

  // 3. Tool loop.
  let answer = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const last = turn === MAX_TURNS - 1;
    emit('status', { phase: turn === 0 ? 'planning' : 'thinking', turn });
    const { message } = await chatStream(messages, {
      tools: last ? undefined : TOOLS,
      signal,
      onEvent: (ev) => emit(ev.type === 'content' ? 'token' : 'reasoning', ev.text),
    });
    if (!message.tool_calls?.length) { answer = message.content; break; }
    if (message.content) emit('reset', {}); // drop any preamble streamed before the tool call

    messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* keep empty */ }
      emit('tool', { name: call.function.name, status: 'running', args });
      const t = Date.now();
      let result;
      try { result = await runTool(call.function.name, args, question, register, fmt); }
      catch (e) { result = { text: `Tool error: ${e.message}`, summary: 'error' }; }
      emit('tool', { name: call.function.name, status: 'done', args, result: result.summary, ms: Date.now() - t });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }

  // 4. Jev checks each cited claim against its source.
  emit('status', { phase: 'verifying' });
  const verification = await verifyCitations(answer, sources).catch(() => []);
  emit('verify', verification);
  return { answer, sources, route };
}

async function runTool(name, args, question, register, fmt) {
  if (name === 'search_documents') {
    const domainIds = findDomain(args.domain) || undefined;
    const hits = await hybrid(args.query || question, { limit: 12, domainIds });
    const graded = await jevRerank(args.query || question, hits, { keep: 6 }).catch(() => hits.slice(0, 6));
    const added = register(graded);
    return { text: added.length ? fmt(added) : 'No matching passages.', summary: `${added.length} passages${domainIds ? ` in ${args.domain}` : ''}` };
  }
  if (name === 'list_domains') {
    const tree = getTree();
    return {
      text: tree.map((a) => `${a.name} (${a.docs} docs)\n${a.domains.map((d) => `  - ${d.name} (${d.docs}): ${d.description}`).join('\n')}`).join('\n'),
      summary: `${tree.length} areas`,
    };
  }
  if (name === 'list_documents') {
    const ids = findDomain(args.domain);
    const kw = args.keyword ? `%${args.keyword}%` : null;
    const rows = db.prepare(`SELECT DISTINCT d.id, d.title, d.country, d.doc_date FROM documents d
      ${ids ? `JOIN document_domains dd ON dd.document_id = d.id AND dd.domain_id IN (${ids.join(',')})` : ''}
      WHERE d.status = 'indexed' ${kw ? 'AND (d.title LIKE ? OR d.country LIKE ?)' : ''} ORDER BY d.doc_date DESC LIMIT 30`)
      .all(...(kw ? [kw, kw] : []));
    return { text: rows.map((r) => `${r.id} | ${r.title} | ${r.country || ''} | ${r.doc_date || ''}`).join('\n') || 'No documents.', summary: `${rows.length} documents` };
  }
  if (name === 'read_page') {
    const rows = db.prepare(`SELECT c.id, c.document_id, c.page, c.text, d.title, d.country, d.doc_date, d.pdf_url, d.source_url
      FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.document_id = ? AND c.page = ? ORDER BY c.ord`).all(String(args.doc_id), Number(args.page));
    if (!rows.length) return { text: 'Page not found.', summary: 'not found' };
    const merged = { ...rows[0], id: `${rows[0].document_id}:${rows[0].page}:page`, text: rows.map((r) => r.text).join(' ').slice(0, 6000) };
    const [s] = register([merged]);
    return { text: fmt([s]), summary: `${rows[0].title.slice(0, 40)}… p.${args.page}` };
  }
  return { text: `Unknown tool ${name}`, summary: 'unknown tool' };
}

// docs.typesafe.ai cookbook "Double-checking citations": one question per
// (claim, cited source) pair, all in a single call.
async function verifyCitations(answer, sources) {
  const sentences = answer.split(/(?<=[.!?])\s+|\n+/).filter((s) => /\[\d+\]/.test(s));
  const pairs = [];
  for (const sentence of sentences) {
    const claim = sentence.replace(/^\s*[-*]?\s*\*\*[^*]{1,60}\*\*:?/, '').replace(/\[\d+\]/g, '').replace(/[*_#>]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const m of sentence.matchAll(/\[(\d+)\]/g)) {
      const src = sources[Number(m[1]) - 1];
      if (src && claim.length > 15 && pairs.length < 24) pairs.push({ n: src.n, claim, source: src.text });
    }
  }
  if (!pairs.length) return [];
  const state = { pairs: Object.fromEntries(pairs.map((p, i) => [`c${i}`, { claim: p.claim, source: p.source }])) };
  const questions = Object.fromEntries(pairs.map((_, i) => [`c${i}`, noul(
    `Is \`pairs.c${i}.claim\` supported by the text in \`pairs.c${i}.source\`?`,
    { true: 'The source states or directly implies the claim', false: 'The source does not contain this claim or contradicts it' },
  )]));
  const ans = await jev(state, questions);
  return pairs.map((p, i) => ({ n: p.n, claim: p.claim, supported: +ans[`c${i}`].noul.toFixed(3) }));
}
