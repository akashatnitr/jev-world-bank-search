import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'worldbank.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,          -- World Bank document id, or up_<hash> for uploads
  title       TEXT NOT NULL,
  doc_type    TEXT,
  country     TEXT,
  doc_date    TEXT,
  abstract    TEXT,
  topic       TEXT,                       -- the seed query that found it (provenance only)
  source_url  TEXT,
  pdf_url     TEXT,
  pdf_path    TEXT,
  pages       INTEGER,
  status      TEXT NOT NULL DEFAULT 'downloaded', -- downloaded|parsed|routed|indexed|failed
  error       TEXT,
  routing     TEXT,                       -- JSON: how the domains were chosen
  created_at  TEXT DEFAULT (datetime('now'))
);

-- The domain graph: a two-level tree. parent_id NULL = area (root).
CREATE TABLE IF NOT EXISTS domains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  parent_id   INTEGER REFERENCES domains(id),
  created_by  TEXT NOT NULL,              -- 'glm'
  created_for TEXT,                       -- document id that triggered creation
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(name, parent_id)
);

CREATE TABLE IF NOT EXISTS document_domains (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  score       REAL NOT NULL,              -- Jev noul probability (1.0 when GLM created it)
  method      TEXT NOT NULL,              -- 'jev' | 'glm'
  PRIMARY KEY (document_id, domain_id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,           -- <doc>:<page>:<n>, also the Vectorize id
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,
  ord         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedded    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id, page);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, title, chunk_id UNINDEXED, tokenize = 'porter unicode61'
);
`);

export const q = {
  doc: db.prepare('SELECT * FROM documents WHERE id = ?'),
  docsByStatus: db.prepare('SELECT * FROM documents WHERE status = ? ORDER BY doc_date DESC'),
  setStatus: db.prepare('UPDATE documents SET status = ?, error = ? WHERE id = ?'),
  areas: db.prepare('SELECT * FROM domains WHERE parent_id IS NULL ORDER BY name'),
  children: db.prepare('SELECT * FROM domains WHERE parent_id = ? ORDER BY name'),
  allDomains: db.prepare('SELECT * FROM domains ORDER BY parent_id, name'),
  domain: db.prepare('SELECT * FROM domains WHERE id = ?'),
};

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
