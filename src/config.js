import { resolve } from 'path';
import { parseSize } from './util/parseSize.js';
import { required, optional } from './util/env.js';

export { parseSize };

function normalizeMountPath(raw) {
  let p = (raw ?? '').trim();
  if (!p) return '';
  if (!p.startsWith('/')) p = '/' + p;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p === '/' ? '' : p;
}

const config = Object.freeze({
  domain: required('DOMAIN'),
  port: parseInt(optional('PORT', '3000'), 10),
  dataDir: resolve(optional('DATA_DIR', './data')),
  totalCapacity: parseSize(optional('TOTAL_CAPACITY', '1G')),
  apiSecret: required('API_SECRET'),
  swaggerUi: optional('SWAGGER_UI', 'false') === 'true',
  operatorApiPathPrefix: normalizeMountPath(optional('OPERATOR_API_PATH_PREFIX', '')),
  operatorCorsOrigins: optional('OPERATOR_CORS_ORIGINS', '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  // Maps hostname → directory path for virtual host serving. Paths are
  // automatically included in staticRoots — no need to list them twice.
  // Format: "example.com:/var/www/html,other.com:/var/www/other"
  virtualHosts: (() => {
    const map = new Map();
    for (const entry of optional('VIRTUAL_HOSTS', '').split(',').map(s => s.trim()).filter(Boolean)) {
      const idx = entry.indexOf(':');
      if (idx < 1) continue;
      const host = entry.slice(0, idx).trim();
      const path = resolve(entry.slice(idx + 1).trim());
      if (host && path) map.set(host, path);
    }
    return map;
  })(),
  // Comma-separated list of absolute directory paths to index as static RASL
  // roots at startup. Files are served by CID without being copied to the blob
  // store. Paths must be pre-approved here; no runtime API can add new roots.
  // Paths listed in VIRTUAL_HOSTS are automatically included.
  staticRoots: (() => {
    const explicit = optional('STATIC_ROOTS', '')
      .split(',').map(s => resolve(s.trim())).filter(Boolean);
    const fromVhosts = optional('VIRTUAL_HOSTS', '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .map(entry => { const idx = entry.indexOf(':'); return idx > 0 ? resolve(entry.slice(idx + 1).trim()) : null; })
      .filter(Boolean);
    return [...new Set([...explicit, ...fromVhosts])];
  })(),
  // Maximum number of MASL versions to keep pinned per static root (including
  // the current one). Older entries are unpinned and become eligible for LRU
  // eviction. Unset or 0 means no limit.
  staticMaxHistory: (() => {
    const n = parseInt(optional('STATIC_MAX_HISTORY', '0'), 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  })(),
});

export default config;
