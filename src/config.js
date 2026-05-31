import { resolve } from 'path';
import { parseSize } from './util/parseSize.js';
import { required, optional } from './util/env.js';
import { normalizeMountPath } from './util/normalizeMountPath.js';
import { parseMountPoints, parseStaticRoots } from './util/parseEnvConfig.js';

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
  mountPoints: parseMountPoints(optional('MOUNT_POINTS', '')),
  // Comma-separated list of absolute directory paths to index as static RASL
  // roots at startup. Files are served by CID without being copied to the blob
  // store. Paths must be pre-approved here; no runtime API can add new roots.
  // Paths listed in MOUNT_POINTS are automatically included.
  staticRoots: parseStaticRoots(optional('STATIC_ROOTS', ''), optional('MOUNT_POINTS', '')),
  // Maximum number of MASL versions to keep pinned per static root (including
  // the current one). Older entries are unpinned and become eligible for LRU
  // eviction. Unset or 0 means no limit.
  staticMaxHistory: (() => {
    const n = parseInt(optional('STATIC_MAX_HISTORY', '0'), 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  })(),
});

export default config;
