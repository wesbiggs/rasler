import { resolve } from 'path';
import { parseSize } from './util/parseSize.js';
import { required, optional } from './util/env.js';
import { normalizeMountPath } from './util/normalizeMountPath.js';

export { parseSize, normalizeMountPath };

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
  // Array of mount point configs for virtual host serving. Each entry maps a
  // hostname (with optional URL path prefix) to a local directory.
  // Format: "hostname[/prefix]:directory" — e.g.:
  //   "example.com:/var/www/html,example.com/docs:/var/www/docs"
  // Entries are sorted longest-prefix-first so more specific mounts win.
  mountPoints: (() => {
    const points = [];
    for (const entry of optional('MOUNT_POINTS', '').split(',').map(s => s.trim()).filter(Boolean)) {
      const idx = entry.indexOf(':');
      if (idx < 1) continue;
      const hostWithPrefix = entry.slice(0, idx).trim();
      const directory = resolve(entry.slice(idx + 1).trim());
      if (!hostWithPrefix || !directory) continue;
      const slashIdx = hostWithPrefix.indexOf('/');
      let hostname, prefix;
      if (slashIdx >= 0) {
        hostname = hostWithPrefix.slice(0, slashIdx);
        prefix = normalizeMountPath(hostWithPrefix.slice(slashIdx));
      } else {
        hostname = hostWithPrefix;
        prefix = '';
      }
      if (hostname) points.push({ hostname, prefix, directory });
    }
    points.sort((a, b) => b.prefix.length - a.prefix.length);
    return points;
  })(),
  // Comma-separated list of absolute directory paths to index as static RASL
  // roots at startup. Files are served by CID without being copied to the blob
  // store. Paths must be pre-approved here; no runtime API can add new roots.
  // Paths listed in MOUNT_POINTS are automatically included.
  staticRoots: (() => {
    const explicit = optional('STATIC_ROOTS', '')
      .split(',').map(s => resolve(s.trim())).filter(Boolean);
    const fromMounts = optional('MOUNT_POINTS', '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .map(entry => { const idx = entry.indexOf(':'); return idx > 0 ? resolve(entry.slice(idx + 1).trim()) : null; })
      .filter(Boolean);
    return [...new Set([...explicit, ...fromMounts])];
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
