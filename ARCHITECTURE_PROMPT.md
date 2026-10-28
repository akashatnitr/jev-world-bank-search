# Architecture prompt: World Bank data-processing layer and agentic RAG

Give this prompt to an engineer or a coding agent to build, or rebuild, the system. The working
implementation in this repo follows it. Values in `code` are the ones the implementation uses.

---

## Role and goal

You are designing the data-processing layer and the question-answering app for a library of
World Bank publications (documents.worldbank.org, the publication store behind worldbank.org and
data.worldbank.org). Documents arrive continuously. Each one must be:

1. parsed locally and quickly,
2. placed into a **domain graph** that grows by itself,
3. indexed for both keyword and semantic retrieval,

and users must be able to ask questions in a web app that shows live sources while they type,
then answers with an agent that cites document names and pages.

## Components and their single responsibilities

| Concern | Component | Why this one |
|---|---|---|
| PDF → text | **liteparse** (`@llamaindex/liteparse`, PDFium, OCR off) | Local, about 2–5 ms per page, per-page text for page-level citations |
| Fast, typed decisions | **Jev** (TypeSafe System One, `POST https://api.typesafe.ai/v1/systemone`, `jev-latest`) | 70–500 ms, calibrated probabilities, cannot return an off-schema answer. Used for every *decision*: domain routing, passage grading, citation checks |
| Text generation | **GLM 5.3 flash** on Cloudflare Workers AI (`@cf/zai-org/glm-5.3-flash`) | Generates the things Jev cannot: new domain names and descriptions, tool-call plans, the final answer |
| Embeddings | Workers AI `@cf/baai/bge-base-en-v1.5` (768-d) | Same account, batch of 100 per call |
| Vector DB | Cloudflare **Vectorize** index `world-bank-docs` (768, cosine) | Managed; ids are `docId:page:n` and map back to local rows |
| Metadata, graph, lexical index | SQLite (`node:sqlite`) + FTS5 (porter) | BM25 answers in about 1 ms, fast enough to run on every keystroke |
| App | Node + Express on **port 3000**, a static single-page front end, SSE for streaming | |

**Design rule:** Jev decides and GLM writes. Never ask GLM to classify when Jev can, and never ask
Jev to produce text.

## Data model

```
documents(id, title, doc_type, country, doc_date, abstract, source_url, pdf_url, pdf_path,
          pages, status: downloaded→parsed→routed→indexed|failed, routing JSON)
domains(id, name, description, parent_id NULL=area, created_by, created_for)   -- 2-level tree
document_domains(document_id, domain_id, score, method: 'jev'|'glm')          -- many-to-many
chunks(id = docId:page:n, document_id, page, ord, text, embedded)
chunks_fts(text, title, chunk_id)                                              -- FTS5
```

A document can carry several domain tags. The tree is **area → domain**, for example
`Climate & Environment → Climate Vulnerability & Adaptation`.

## Ingestion pipeline (per document)

1. **Acquire.** Query the World Bank Documents & Reports API
   (`search.worldbank.org/api/v3/wds`, `majdocty_exact=Publications & Research`,
   `lang_exact=English`). Spread the queries across themes and take them round-robin. Reject PDFs
   larger than 25 MB and anything without a `%PDF-` header.
2. **Parse.** Run liteparse to get per-page text. Strip the "Public Disclosure Authorized"
   stamps. Cap at `WB_MAX_PAGES=80` pages per document. Fail any document with under 500 chars of
   text: it is a scan, so OCR would be needed.
3. **Chunk.** Cut about 1,100 characters per chunk with 150 characters of overlap, preferring
   sentence boundaries. Chunks never cross pages, so every chunk keeps its page number for
   citations. Write the chunks to `chunks` and `chunks_fts`.
4. **Route into the domain graph.** This step is strictly sequential, because each document can
   grow the tree that the next one sees.
   - Jev state: `{title, country_or_region, document_type, abstract, excerpt}`. Keep it small,
     since Jev loses accuracy when the state carries irrelevant text.
   - **Speculative fan-out:** one Jev call with a *noul* for every area and every domain, using
     structured instructions:
     `{domain:{name, description, part_of}, question:"Is the document in \`state\` substantially about the topic described in \`domain\`?"}`.
     Above 200 questions, switch to two calls that walk the tree: areas first, then the children
     of areas that score ≥ 0.35.
   - **Accept** each domain whose noul is ≥ `WB_DOMAIN_THRESHOLD=0.7` and whose area noul is
     ≥ 0.35. Keep at most 4 tags. Record `method='jev'` and the score.
   - **Otherwise** (no domain clears the threshold, which is always the case for the first
     document) call GLM with the current tree, the 3 closest near-misses with their Jev scores,
     and the document. GLM returns JSON with 1–2 new domains, each placed under an existing area or
     a new one, with a one-sentence scope. Normalise names (`&`/`and`, case, punctuation) so
     near-duplicates are not created. Tag the document with `method='glm'`.
   - Persist the routing trace (top scores, timings, what was created) on the document so it can
     be explained in the UI.
5. **Embed and upsert.** Embed `title + chunk` with bge, then upsert NDJSON to Vectorize in
   batches of 500 with metadata `{doc_id, page}`. This step runs concurrently, up to 4 documents
   in flight, behind the sequential routing step.
6. Every step is **resumable** from `status`. Uploads (`POST /api/documents` with a PDF body or
   `{url}`) run the same pipeline under an in-process lock and stream each step over SSE.

## Retrieval

- `lexical(q)`: FTS5 BM25 over chunks, with prefix matching on the last token so partial words
  match while the user types.
- `semantic(q)`: bge embedding, then a Vectorize `topK=50` query.
- `hybrid(q, {domainIds})`: reciprocal rank fusion (k = 60) of the two rankings, an optional
  domain filter, and at most 3 chunks per document.
- `jevRerank(question, passages)`: one Jev call with a noul per passage ("does `passages.pN`
  help answer `question`?"). Keep passages ≥ 0.35, up to 8. This follows TypeSafe's
  "Classifying RAG passages" cookbook.

## Live sources while typing

- On **every keystroke**, `GET /api/live/lexical` returns BM25 hits grouped by document, with
  highlighted snippets (about 1–7 ms on the server).
- After **220 ms idle**, `GET /api/live/semantic` runs hybrid retrieval and **Jev query routing**
  in parallel (`routeQuery`: the same fan-out nouls with "question" as the subject, keeping
  domains ≥ 0.5). The whole call takes about 0.5 s; Jev's part is about 110 ms.
- The client aborts stale requests, caches semantic results per string, and merges the two lists
  (semantic first, then lexical extras). It shows the document name, page, the method that matched
  (`bm25`, `vector` or both), and Jev's domain chips with percentages.

## Agentic answer (`POST /api/ask`, SSE)

1. Run in parallel: Jev `routeQuery` (emits `route`) and `hybrid(question, 14)`.
2. `jevRerank` the passages. The survivors become numbered sources `[1]…[n]` (emits `source`).
3. GLM tool loop, at most 4 turns, streamed (emits `reasoning`, `token` and `tool`). Tools:
   - `search_documents(query, domain?)`: hybrid search plus Jev rerank. Each new passage gets the
     next source number.
   - `list_domains()`: the tree with document counts.
   - `list_documents(domain?, keyword?)`
   - `read_page(doc_id, page)`: the full page, registered as a source.
   The system prompt requires a citation on every factual sentence and no invented numbers. When
   the evidence is missing, the answer must say so.
4. **Citation check with Jev** ("Double-checking citations" cookbook): split the answer into
   cited sentences, then make one Jev call with a noul per (claim, cited source) pair, up to 24
   pairs. The UI turns each citation green (≥ 0.5) or amber (below 0.5) (emits `verify`).
5. Optional `domainIds` scope from the UI restricts every retrieval to a subtree.

## Front end

- Sidebar: stats, and the collapsible **domain tree** with document counts. Clicking a node opens
  its documents, each with its Jev score or "glm created", plus an "Ask within this domain" scope.
- Thread: question, a collapsible **agent trace** (Jev route, then Jev grading, then GLM tool
  calls with timings, then Jev verification, with live reasoning shown as a ticker), the streamed
  answer with citation chips, and source cards (document, page, Jev relevance, support badge,
  domains).
- Composer at the bottom with the **live sources tray** above it. Source drawers link to the
  local PDF at `#page=N` and to the worldbank.org record.
- An "Add document" modal streams parse → route (shows the Jev match or the GLM creation) →
  index.

## Operating constraints learned while building

- GLM 5.3 flash **always reasons first**, and its reasoning counts toward `max_tokens`. Use
  budgets of 6k–12k and a 150 s timeout. A trivial JSON reply takes about 16 s, and a domain
  proposal takes 30–45 s. That cost is acceptable only because GLM runs on routing misses, which
  become rare once the tree has filled in.
- Jev: 64k context, at most 255 options per Choice, 80 req/s. It reads literally, so put the
  exact condition and the boundary cases in `criteria`. Keep the state small. Use nouls (an
  independent probability per domain) instead of one Choice, because a document can belong to
  several domains.
- Vectorize is eventually consistent: new vectors become queryable a few seconds after upsert.
  BM25 covers that gap.
- Read only the needed keys from `.env` (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCOUNT_TOKEN`,
  `JEV_API_KEY`). The shared `.env` also holds `PORT=8000` for a different service, so the app
  reads its port from `WB_PORT`, which defaults to 3000.

## Success criteria

- 100–150 World Bank PDFs ingested, each with ≥ 1 domain, and the routing method visible.
- After the first ~25 documents (one per theme), most new documents route via Jev without GLM.
- Live tray: BM25 results on every keystroke; Jev domains and semantic results within about 1 s.
- Every answer cites the document name and page, and Jev's support check is shown.
