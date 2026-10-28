# World Bank Knowledge Graph: agentic RAG

Ingests World Bank publications with **liteparse**, routes each one into a self-growing **domain
graph** with **Jev** (TypeSafe System One), and uses **GLM 5.3 flash** on Cloudflare Workers AI
to create new domains when nothing fits. Chunks are indexed in the Cloudflare **Vectorize** index
`world-bank-docs` and in SQLite FTS5. A web app on **port 3000** shows live sources while you type
and answers with a tool-calling agent whose citations are checked by Jev.

The full design is in [ARCHITECTURE_PROMPT.md](ARCHITECTURE_PROMPT.md).

## Run

```bash
npm install
node src/ingest/fetch-docs.js 140     # download ~140 PDFs from the World Bank Documents API
node src/ingest/ingest.js             # parse → route (Jev/GLM) → embed → Vectorize  (resumable)
node src/server.js                    # http://localhost:3000
```

The app reads only `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCOUNT_TOKEN` and `JEV_API_KEY` from
`.env`. Optional settings: `WB_PORT` (default 3000), `WB_DOMAIN_THRESHOLD` (0.7),
`WB_AREA_THRESHOLD` (0.35), `WB_MAX_PAGES` (80), `WB_VECTOR_INDEX` (`world-bank-docs`).

## Layout

| File | Role |
|---|---|
| `src/ingest/fetch-docs.js` | Queries the World Bank WDS API across 24 themes and downloads the PDFs |
| `src/pipeline.js` | Runs liteparse, does page-aware chunking and FTS indexing, then embeds and upserts to Vectorize |
| `src/domains.js` | Domain graph: Jev fan-out routing, GLM domain creation, query routing |
| `src/search.js` | BM25, vector search, RRF hybrid, and Jev passage grading |
| `src/agent.js` | GLM tool loop (`search_documents`, `list_domains`, `list_documents`, `read_page`) and Jev citation check |
| `src/server.js` | API and SSE: `/api/live/lexical`, `/api/live/semantic`, `/api/ask`, `/api/documents`, `/api/domains` |
| `public/` | The web app |

## API

- `GET /api/live/lexical?q=`: BM25 sources, fast enough to run on every keystroke
- `GET /api/live/semantic?q=`: hybrid sources plus the Jev domain route
- `POST /api/ask {question, history?, domainIds?}`: an SSE stream of `route`, `source`, `tool`,
  `reasoning`, `token`, `verify` and `done` events
- `POST /api/documents`: send a PDF body (`Content-Type: application/pdf`, `X-Filename`) or
  `{url}`. Returns an SSE stream of the ingestion steps.
- `GET /api/domains`, `GET /api/domains/:id`, `GET /api/documents/:id`, `GET /pdf/:id`
