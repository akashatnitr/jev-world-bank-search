// Cloudflare Workers AI (GLM flash, bge embeddings) and Vectorize over REST.
import { config } from './config.js';

const BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cfAccountId}`;
const auth = { Authorization: `Bearer ${config.cfToken}` };

async function cfFetch(path, init = {}, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { ...init, headers: { ...auth, ...init.headers } });
    if (res.ok) return res;
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500 || (res.status === 401 && attempt === 0)) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    const err = new Error(`Cloudflare ${res.status} ${path}: ${body.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
}

// ---------- GLM ----------

// GLM 5.3 flash always reasons before answering and the reasoning counts
// against max_tokens, so budgets here are generous.
export async function chat(messages, { tools, maxTokens = 6000, temperature = 0.2, timeoutMs = 150_000 } = {}) {
  const res = await cfFetch(`/ai/run/${config.llmModel}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature, ...(tools && { tools }) }),
  });
  const { result } = await res.json();
  return result.choices[0];
}

// Streams an OpenAI-style completion. Calls onEvent({type:'reasoning'|'content', text}).
// Resolves to the assembled assistant message, including tool_calls.
export async function chatStream(messages, { tools, maxTokens = 8000, temperature = 0.2, onEvent, signal } = {}) {
  const res = await cfFetch(`/ai/run/${config.llmModel}`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature, stream: true, ...(tools && { tools }) }),
  });
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  let finish = null;
  let buf = '';
  const decoder = new TextDecoder();
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      const c = ev.choices?.[0];
      if (!c) continue;
      const d = c.delta || {};
      if (d.reasoning_content) onEvent?.({ type: 'reasoning', text: d.reasoning_content });
      if (d.content) { msg.content += d.content; onEvent?.({ type: 'content', text: d.content }); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? msg.tool_calls.length;
        const slot = (msg.tool_calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (c.finish_reason) finish = c.finish_reason;
    }
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  if (!msg.tool_calls.length) delete msg.tool_calls;
  return { message: msg, finish };
}

// Pulls the first JSON object/array out of a model reply.
export function parseJson(text) {
  const s = text.replace(/```(?:json)?/g, '');
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in model output');
  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('unterminated JSON in model output');
}

// ---------- Embeddings ----------

export async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const res = await cfFetch(`/ai/run/${config.embedModel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts.slice(i, i + 100) }),
    });
    out.push(...(await res.json()).result.data);
  }
  return out;
}

// ---------- Vectorize ----------

const VX = `/vectorize/v2/indexes`;

export async function ensureIndex() {
  try {
    await cfFetch(`${VX}/${config.vectorIndex}`);
    return false;
  } catch (e) {
    if (e.status !== 404 && e.status !== 410 && e.status !== 400) throw e;
  }
  await cfFetch(VX, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: config.vectorIndex,
      description: 'World Bank documents (liteparse chunks, bge-base-en-v1.5)',
      config: { dimensions: config.embedDims, metric: 'cosine' },
    }),
  });
  return true;
}

export async function upsertVectors(vectors) {
  for (let i = 0; i < vectors.length; i += 500) {
    const ndjson = vectors.slice(i, i + 500).map((v) => JSON.stringify(v)).join('\n');
    await cfFetch(`${VX}/${config.vectorIndex}/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: ndjson,
    });
  }
}

export async function queryVectors(vector, topK = 30) {
  const res = await cfFetch(`${VX}/${config.vectorIndex}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, topK, returnValues: false, returnMetadata: 'none' }),
  });
  return (await res.json()).result.matches || [];
}

export async function indexInfo() {
  const res = await cfFetch(`${VX}/${config.vectorIndex}/info`);
  return (await res.json()).result;
}
