// Reads only the keys this app needs from .env. The shared .env holds many
// unrelated secrets (and PORT=8000 for another service), so nothing else is
// pulled into process.env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WANTED = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_TOKEN', 'JEV_API_KEY'];

function readEnvFile() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && WANTED.includes(m[1])) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = readEnvFile();
const get = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

export const config = {
  port: Number(process.env.WB_PORT || 3000),
  cfAccountId: get('CLOUDFLARE_ACCOUNT_ID'),
  cfToken: get('CLOUDFLARE_ACCOUNT_TOKEN'),
  jevKey: get('JEV_API_KEY'),
  jevModel: process.env.JEV_MODEL || 'jev-latest',
  llmModel: process.env.WB_LLM_MODEL || '@cf/zai-org/glm-5.3-flash',
  embedModel: '@cf/baai/bge-base-en-v1.5',
  embedDims: 768,
  vectorIndex: process.env.WB_VECTOR_INDEX || 'world-bank-docs',
  // A document joins an existing domain when Jev's noul for it reaches this.
  domainThreshold: Number(process.env.WB_DOMAIN_THRESHOLD || 0.7),
  // Areas (tree roots) whose noul reaches this are expanded to their children.
  areaThreshold: Number(process.env.WB_AREA_THRESHOLD || 0.35),
  maxPagesPerDoc: Number(process.env.WB_MAX_PAGES || 80),
  dataDir: path.join(ROOT, 'data'),
};

for (const k of ['cfAccountId', 'cfToken', 'jevKey']) {
  if (!config[k]) throw new Error(`Missing ${k} (check .env)`);
}
