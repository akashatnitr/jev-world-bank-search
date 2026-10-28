const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// FTS snippets arrive with <mark> tags around matches; escape everything else.
const safeSnippet = (s) => esc(s).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');

const state = { scope: null, history: [], busy: false, tree: [] };

// ---------------- stats & tree ----------------

async function loadStats() {
  const s = await (await fetch('/api/stats')).json();
  $('#stats').innerHTML = [
    [s.indexed_docs, "documents"], [s.vectors.toLocaleString(), 'vectors'], [s.pages.toLocaleString(), 'pages'],
    [s.areas, 'areas'], [s.domains, 'domains'], [`${s.routed_jev}/${s.routed_glm}`, 'jev / glm'],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('#vx-name').textContent = s.vector_index;
}

async function loadTree() {
  const tree = await (await fetch('/api/domains')).json();
  const open = new Set([...document.querySelectorAll('.area.open')].map((e) => e.dataset.id));
  state.tree = tree;
  $('#tree').innerHTML = tree.map((a) => `
    <div class="area ${open.has(String(a.id)) ? 'open' : ''}" data-id="${a.id}">
      <button class="area-row" data-area="${a.id}"><span class="caret">▶</span>${esc(a.name)}<span class="count">${a.docs}</span></button>
      <div class="area-kids">
        ${a.domains.map((d) => `<button class="dom-row" data-domain="${d.id}" title="${esc(d.description)}">${esc(d.name)}<span class="count">${d.docs}</span></button>`).join('')}
      </div>
    </div>`).join('') || '<div class="muted" style="font-size:13px">No domains yet: ingest documents to grow the graph.</div>';
  markScope();
}

$('#tree').addEventListener('click', (e) => {
  const area = e.target.closest('[data-area]');
  const dom = e.target.closest('[data-domain]');
  if (area) {
    const el = area.parentElement;
    if (!el.classList.contains('open')) { el.classList.add('open'); return; }
    openDomain(area.dataset.area);
  }
  if (dom) openDomain(dom.dataset.domain);
});

function setScope(domain) {
  state.scope = domain;
  $('#scope-pill').classList.toggle('hidden', !domain);
  $('#scope-clear').classList.toggle('hidden', !domain);
  if (domain) $('#scope-pill').textContent = `Scope: ${domain.name}`;
  markScope();
}
function markScope() {
  document.querySelectorAll('.dom-row, .area-row').forEach((b) => b.classList.remove('active'));
  if (!state.scope) return;
  const sel = state.scope.parent_id ? `[data-domain="${state.scope.id}"]` : `[data-area="${state.scope.id}"]`;
  document.querySelector(sel)?.classList.add('active');
}
$('#scope-clear').onclick = () => setScope(null);

// ---------------- drawer ----------------

function drawer(html) { $('#drawer-body').innerHTML = html; $('#drawer').classList.remove('hidden'); }
document.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) $('#drawer').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#drawer').classList.add('hidden'); $('#modal').classList.add('hidden'); } });

const domainChips = (domains = [], cls = '') => `<div class="chips">${domains.map((d) => `<span class="chip ${cls}" title="${esc(d.area)}">${esc(d.name)}</span>`).join('')}</div>`;

async function openDomain(id) {
  const d = await (await fetch(`/api/domains/${id}`)).json();
  drawer(`
    <div class="kicker">${d.parent ? `${esc(d.parent.name)} › domain` : 'area'} · created by ${esc(d.created_by.toUpperCase())}</div>
    <h2>${esc(d.name)}</h2>
    <p class="muted">${esc(d.description)}</p>
    <button class="btn primary" id="scope-btn">Ask within this ${d.parent ? 'domain' : 'area'}</button>
    ${d.children.length ? `<h4>Domains</h4>${domainChips(d.children.map((c) => ({ ...c, area: d.name })))}` : ''}
    <h4>${d.documents.length} documents</h4>
    ${d.documents.map((doc) => `<div class="doc-row" data-doc="${doc.id}">
      <div class="src-title">${esc(doc.title)}</div>
      <div class="src-meta">${esc(doc.country || '')} · ${esc((doc.doc_date || '').slice(0, 4))} · ${doc.pages || '?'}p ·
        <span class="badge ${doc.method === 'jev' ? '' : ''}">${doc.method === 'jev' ? `jev ${doc.score.toFixed(2)}` : 'glm created'}</span></div>
    </div>`).join('')}`);
  $('#scope-btn').onclick = () => {
    const ids = d.parent ? [d.id] : d.children.map((c) => c.id);
    setScope({ id: d.id, name: d.name, parent_id: d.parent_id, ids });
    $('#drawer').classList.add('hidden');
    $('#input').focus();
  };
}

$('#drawer').addEventListener('click', (e) => {
  const row = e.target.closest('[data-doc]');
  if (row) openDoc(row.dataset.doc);
});

async function openDoc(id, page) {
  const d = await (await fetch(`/api/documents/${id}`)).json();
  const r = d.routing;
  drawer(`
    <div class="kicker">${esc(d.doc_type || 'Document')}</div>
    <h2>${esc(d.title)}</h2>
    <dl class="kv">
      <dt>Country</dt><dd>${esc(d.country || '—')}</dd>
      <dt>Date</dt><dd>${esc(d.doc_date || '—')}</dd>
      <dt>Pages</dt><dd>${d.pages ?? '—'} (${d.chunks} chunks)</dd>
      <dt>Open</dt><dd><a href="/pdf/${d.id}${page ? `#page=${page}` : ''}" target="_blank">PDF${page ? ` p.${page}` : ''}</a>${d.source_url ? ` · <a href="${esc(d.source_url)}" target="_blank" rel="noopener">worldbank.org</a>` : ''}</dd>
    </dl>
    ${d.abstract ? `<p class="muted" style="font-size:13.5px">${esc(d.abstract.slice(0, 700))}${d.abstract.length > 700 ? '…' : ''}</p>` : ''}
    <h4>Domains ${domainChips(d.domains, r?.method === 'glm' ? 'glm' : 'jev')}</h4>
    ${r ? `<h4>How it was routed</h4>
      <p style="font-size:13px">${r.method === 'jev'
        ? `<b style="color:var(--jev)">Jev</b> matched existing domains above the ${r.threshold} threshold in ${r.jev_ms} ms.`
        : `No existing domain reached ${r.threshold} (Jev, ${r.jev_ms} ms), so <b style="color:var(--glm)">GLM</b> created ${r.created?.length ? r.created.map((c) => `<i>${esc(c.name)}</i> (${c.kind})`).join(', ') : 'domains'} in ${(r.glm_ms / 1000).toFixed(1)} s.`}</p>
      ${(r.top || []).map((t) => `<div class="routing-row">${esc(t.path)} <span class="count">${t.score.toFixed(2)}</span><div class="bar"><i style="width:${t.score * 100}%"></i></div></div>`).join('')}` : ''}`);
}

// ---------------- live sources while typing ----------------

const input = $('#input');
let lexAbort, semAbort, semTimer, lastText = '';
const semCache = new Map();
let live = { text: '', lex: null, sem: null, lexMs: null };

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  const text = input.value.trim();
  if (text === lastText) return;
  lastText = text;
  if (text.length < 3) { $('#live').classList.add('hidden'); return; }
  live = { text, lex: null, sem: semCache.get(text) || null };
  fetchLexical(text);
  clearTimeout(semTimer);
  if (!live.sem) semTimer = setTimeout(() => fetchSemantic(text), 220);
  else renderLive();
});

async function fetchLexical(text) {
  lexAbort?.abort();
  lexAbort = new AbortController();
  const t = performance.now();
  try {
    const r = await (await fetch(`/api/live/lexical?q=${encodeURIComponent(text)}`, { signal: lexAbort.signal })).json();
    if (text !== live.text) return;
    live.lex = r; live.lexRtt = performance.now() - t;
    renderLive();
  } catch { /* superseded */ }
}

async function fetchSemantic(text) {
  semAbort?.abort();
  semAbort = new AbortController();
  try {
    const r = await (await fetch(`/api/live/semantic?q=${encodeURIComponent(text)}`, { signal: semAbort.signal })).json();
    semCache.set(text, r);
    if (text !== live.text) return;
    live.sem = r;
    renderLive();
  } catch { /* superseded */ }
}

function renderLive() {
  const items = [];
  const seen = new Set();
  for (const s of live.sem?.sources || []) { if (!seen.has(s.id)) { seen.add(s.id); items.push({ ...s, kind: s.via?.join('+') || 'vector' }); } }
  for (const s of live.lex?.sources || []) { if (!seen.has(s.id)) { seen.add(s.id); items.push({ ...s, kind: 'bm25' }); } }
  const box = $('#live');
  if (!items.length && !live.sem?.route?.domains?.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const prev = new Set([...document.querySelectorAll('.lsrc')].map((e) => e.dataset.id));
  $('#live-sources').innerHTML = items.slice(0, 7).map((s) => `
    <div class="lsrc ${prev.has(s.id) ? '' : 'new'}" data-id="${s.id}" data-page="${s.page}">
      <span class="t">${esc(s.title)}</span><span class="p">p.${s.page} · ${s.kind}</span>
      <span class="s">${safeSnippet(s.snippet)}</span>
    </div>`).join('');
  const route = live.sem?.route;
  $('#live-domains').innerHTML = route
    ? (route.domains.length ? `<span>Jev →</span>${route.domains.map((d) => `<span class="chip jev" title="${esc(d.area)}">${esc(d.name)} ${(d.score * 100).toFixed(0)}%</span>`).join('')}` : '<span>Jev: no domain above 50%</span>')
    : '<span class="spinner"></span><span>routing…</span>';
  const parts = [];
  if (live.lex) parts.push(`bm25 ${live.lex.ms}ms`);
  if (live.sem) parts.push(`hybrid+jev ${live.sem.ms}ms`, `jev ${route?.ms ?? '–'}ms`);
  $('#live-timing').textContent = parts.join(' · ');
}

$('#live-sources').addEventListener('click', (e) => {
  const row = e.target.closest('.lsrc');
  if (row) openDoc(row.dataset.id, row.dataset.page);
});

// ---------------- asking ----------------

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); ask(input.value.trim()); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value.trim()); }
});

function md(text, verify = {}) {
  // Minimal markdown: headings, bold/italic, lists, tables, paragraphs, [n] citations.
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[(\d+)\]/g, (_, n) => {
      const v = verify[n];
      const cls = v == null ? '' : v >= 0.5 ? 'ok' : 'weak';
      return `<span class="cite ${cls}" data-n="${n}" title="${v == null ? 'source ' + n : `Jev support: ${(v * 100).toFixed(0)}%`}">${n}</span>`;
    });
  const lines = text.split('\n');
  let html = '', list = null, table = [];
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\s*\||\|\s*$/g, '').split('|'));
    html += `<table>${rows.map((r, i) => `<tr>${r.map((c) => `<${i ? 'td' : 'th'}>${inline(c.trim())}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;
    table = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); table.push(line); continue; }
    flushTable();
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { flushList(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) flushList();
    else { flushList(); html += `<p>${inline(line)}</p>`; }
  }
  flushList(); flushTable();
  return html;
}

const TOOL_LABEL = {
  jev_rerank: ['jev', 'graded passages'],
  search_documents: ['tool', 'search_documents'],
  list_domains: ['tool', 'list_domains'],
  list_documents: ['tool', 'list_documents'],
  read_page: ['tool', 'read_page'],
};

async function ask(question) {
  if (!question || state.busy) return;
  state.busy = true;
  $('#send').disabled = true;
  $('#welcome')?.remove();
  input.value = ''; input.style.height = 'auto'; lastText = '';
  lexAbort?.abort(); semAbort?.abort(); clearTimeout(semTimer);
  live = { text: null };
  $('#live').classList.add('hidden');

  const turn = document.createElement('section');
  turn.className = 'turn';
  turn.innerHTML = `
    <h2 class="q">${esc(question)}</h2>
    <details class="trace" open>
      <summary><span class="spinner"></span><span class="trace-title">Routing with Jev…</span></summary>
      <div class="steps-list"></div>
      <div class="thinking"></div>
    </details>
    <div class="answer cursor"></div>
    <div class="verify-sum"></div>
    <div class="src-grid"></div>`;
  $('#thread').appendChild(turn);
  turn.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const steps = $('.steps-list', turn), title = $('.trace-title', turn), thinking = $('.thinking', turn);
  const answerEl = $('.answer', turn), grid = $('.src-grid', turn);
  const sources = [];
  const toolRows = new Map();
  let answer = '', reasoning = '', verify = {};
  const t0 = performance.now();
  let finished = false;

  const step = (who, label, detail = '', ms = '') => {
    const el = document.createElement('div');
    el.className = 'tstep';
    el.innerHTML = `<span class="who ${who}">${who}</span><span>${label} <span class="muted">${detail}</span></span><span class="ms">${ms}</span>`;
    steps.appendChild(el);
    return el;
  };

  const renderSources = () => {
    grid.innerHTML = sources.map((s) => {
      const v = verify[s.n];
      return `<div class="src" data-n="${s.n}">
        <div class="src-top"><span class="src-n">[${s.n}]</span><span class="badge">p.${s.page}</span>
          ${s.relevance != null ? `<span class="badge" title="Jev relevance">rel ${(s.relevance * 100).toFixed(0)}%</span>` : ''}
          ${v != null ? `<span class="badge ${v >= 0.5 ? 'ok' : 'weak'}">${v >= 0.5 ? '✓ supported' : '? weak'}</span>` : ''}</div>
        <div class="src-title">${esc(s.title)}</div>
        <div class="src-meta">${esc(s.country || '')} ${s.doc_date ? '· ' + s.doc_date.slice(0, 4) : ''}</div>
        ${domainChips(s.domains)}
      </div>`;
    }).join('');
  };

  grid.onclick = answerEl.onclick = (e) => {
    const n = e.target.closest('[data-n]')?.dataset.n;
    const s = sources[n - 1];
    if (!s) return;
    drawer(`<div class="kicker">Source [${s.n}] · page ${s.page}</div><h2>${esc(s.title)}</h2>
      ${domainChips(s.domains)}
      <p style="font:16px/1.6 var(--serif); white-space:pre-wrap">${esc(s.text)}</p>
      <p><a href="/pdf/${s.document_id}#page=${s.page}" target="_blank">Open PDF at page ${s.page}</a>${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noopener">worldbank.org</a>` : ''}
       · <a href="#" data-doc-open="${s.document_id}">document details</a></p>`);
    $('[data-doc-open]').onclick = (ev) => { ev.preventDefault(); openDoc(s.document_id); };
  };

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: state.history, domainIds: state.scope?.ids }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? 'null');
        handle(ev, data);
      }
    }
  } catch (e) {
    answerEl.insertAdjacentHTML("beforeend", `<p class="err">${esc(e.message)}</p>`);
    finish("Failed");
  }

  function handle(ev, d) {
    if (ev === 'route') {
      step('jev', 'routed to', d.domains.map((x) => `${x.name} ${(x.score * 100).toFixed(0)}%`).join(', ') || 'no domain above 50%', `${d.ms}ms`);
      title.textContent = 'Retrieving & grading evidence…';
    } else if (ev === 'source') {
      sources.push(d); renderSources();
    } else if (ev === 'tool') {
      const [who, label] = TOOL_LABEL[d.name] || ['tool', d.name];
      const key = d.name + JSON.stringify(d.args || {});
      if (d.status === 'running') {
        const args = d.args && Object.keys(d.args).length ? Object.entries(d.args).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
        toolRows.set(key, step(who, label, esc(args), '…'));
        if (who === 'tool') title.textContent = `GLM called ${d.name}…`;
      } else {
        const row = toolRows.get(key);
        if (row) { $('.ms', row).textContent = `${d.ms}ms`; $('.muted', row).innerHTML += ` → ${esc(d.result)}`; }
      }
    } else if (ev === 'status') {
      title.textContent = { planning: 'GLM is reading the evidence…', thinking: 'GLM is reasoning over new evidence…', verifying: 'Jev is checking citations…' }[d.phase] || d.phase;
      if (d.phase !== 'verifying') { reasoning = ''; }
    } else if (ev === 'reasoning') {
      reasoning += d;
      thinking.textContent = '… ' + reasoning.slice(-180).replace(/\s+/g, ' ');
    } else if (ev === 'reset') {
      answer = ''; answerEl.innerHTML = '';
    } else if (ev === 'token') {
      thinking.textContent = '';
      title.textContent = 'Writing answer…';
      answer += d;
      answerEl.innerHTML = md(answer);
    } else if (ev === 'verify') {
      for (const v of d) verify[v.n] = Math.max(verify[v.n] ?? 0, v.supported);
      answerEl.innerHTML = md(answer, verify);
      renderSources();
      const ok = d.filter((v) => v.supported >= 0.5).length;
      if (d.length) $('.verify-sum', turn).innerHTML = `<span class="who jev" style="font:500 11px var(--mono);padding:1px 6px;border-radius:4px">jev</span> ${ok}/${d.length} cited claims supported by their source`;
      step('jev', 'verified citations', `${ok}/${d.length} supported`);
    } else if (ev === 'done') {
      finish(`Done in ${(d.ms / 1000).toFixed(1)}s · ${sources.length} sources`);
    } else if (ev === 'error') {
      answerEl.innerHTML += `<p class="err">${esc(d.message)}</p>`;
      finish('Failed');
    }
  }

  function finish(msg) {
    if (finished) return;
    finished = true;
    answerEl.classList.remove('cursor');
    thinking.remove();
    $('.spinner', turn)?.remove();
    title.textContent = msg;
    $('.trace', turn).open = false;
  }
  finish(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${sources.length} sources`);
  state.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  state.busy = false;
  $('#send').disabled = false;
  input.focus();
}

// ---------------- add document ----------------

$('#add-doc').onclick = () => { $('#modal').classList.remove('hidden'); $('#add-steps').innerHTML = ''; };
$('[data-close-modal]').onclick = () => $('#modal').classList.add('hidden');

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, file = form.file.files[0], url = form.url.value.trim();
  if (!file && !url) return;
  const ol = $('#add-steps');
  ol.innerHTML = '';
  const li = (html, cls = '') => { const el = document.createElement('li'); el.className = cls; el.innerHTML = html; ol.appendChild(el); return el; };
  const btn = $('button[type=submit]', form); btn.disabled = true;
  const res = await fetch('/api/documents', file
    ? { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) }, body: file }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', newId = null;
  const running = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.*)$/m)?.[1];
      const d = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? 'null');
      if (ev === 'created') { newId = d.id; li(`Stored <b>${esc(d.title)}</b>`, 'done'); }
      if (ev === 'exists') { newId = d.id; li('Already in the library.', 'done'); }
      if (ev === 'error') li(`<span class="err">${esc(d.message)}</span>`);
      if (ev === 'step') {
        const names = { download: 'Downloading', parse: 'Parsing with liteparse', route: 'Routing into the domain graph', index: 'Embedding into Vectorize', error: 'Error' };
        if (d.status === 'running') { running[d.step] = li(`<span class="spinner" style="display:inline-block;vertical-align:-2px"></span> ${names[d.step]}…`); continue; }
        const el = running[d.step] || li('');
        el.className = d.status === 'done' ? 'done' : '';
        if (d.step === 'parse') el.innerHTML = `Parsed ${d.pages} pages into ${d.chunks} chunks <span class="muted">(${d.ms} ms)</span>`;
        else if (d.step === 'route') {
          const r = d.routing;
          el.innerHTML = r.method === 'jev'
            ? `<b style="color:var(--jev)">Jev</b> matched: ${r.tags.map((t) => `${esc(t.path)} (${(t.score * 100).toFixed(0)}%)`).join(', ')} <span class="muted">(${r.jev_ms} ms)</span>`
            : `Nothing above ${r.threshold}; <b style="color:var(--glm)">GLM</b> created ${r.created.map((c) => `${esc(c.name)} <span class="muted">(${c.kind})</span>`).join(', ') || 'no new nodes'} and tagged ${r.tags.map((t) => esc(t.path)).join(', ')}`;
        } else if (d.step === 'index') el.innerHTML = `Upserted ${d.vectors} vectors <span class="muted">(${d.ms} ms)</span>`;
        else if (d.step === 'download') el.innerHTML = `Downloaded ${(d.bytes / 1e6).toFixed(1)} MB`;
        else el.innerHTML = `<span class="err">${esc(d.error)}</span>`;
      }
      if (ev === 'done') { li('Ready to query.', 'done'); loadTree(); loadStats(); }
    }
  }
  btn.disabled = false;
  if (newId) { const a = li(`<a href="#">Open document</a>`); a.querySelector('a').onclick = (ev) => { ev.preventDefault(); $('#modal').classList.add('hidden'); openDoc(newId); }; }
});

// ---------------- boot ----------------

const EXAMPLES = [
  'What is learning poverty and how is it measured?',
  'How do countries manage rising public debt?',
  'Compare approaches to climate adaptation finance',
  'What drives inflation expectations in emerging markets?',
  'How effective are cash transfers in reducing poverty?',
];
$('#examples').innerHTML = EXAMPLES.map((q) => `<button>${esc(q)}</button>`).join('');
$('#examples').onclick = (e) => { if (e.target.tagName === 'BUTTON') { input.value = e.target.textContent; input.dispatchEvent(new Event('input')); input.focus(); } };

loadStats(); loadTree();
setInterval(() => { loadStats(); loadTree(); }, 20_000);
input.focus();
