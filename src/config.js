import { resolve } from 'path';
import { parseSize } from './util/parseSize.js';
import { required, optional } from './util/env.js';
import { normalizeMountPath } from './util/normalizeMountPath.js';
import { parseMountPoints, parseStaticRoots } from './util/parseEnvConfig.js';

export { parseSize, normalizeMountPath };

const port = parseInt(optional('PORT', '3000'), 10);

// Accept a bare hostname (e.g. "node1.example.com") for backwards compat and
// default it to https://. A full origin (e.g. "http://localhost:3000") is used
// as-is so the correct protocol appears in Link: rel="duplicate" headers.
const originRaw = optional('ORIGIN', `http://localhost:${port}`);
const originUrl = new URL(/^https?:\/\//.test(originRaw) ? originRaw : `https://${originRaw}`);

const config = Object.freeze({
  origin: originUrl.origin,
  domain: originUrl.host,
  port,
  dataDir: resolve(optional('DATA_DIR', './data')),
  totalCapacity: parseSize(optional('TOTAL_CAPACITY', '1G')),
  apiSecret: (() => {
    const secret = required('API_SECRET');
    if (secret === 'change-me-to-a-strong-random-secret') {
      throw new Error('API_SECRET is still set to the default placeholder — please change it before starting the server');
    }
    return secret;
  })(),
  swaggerUi: optional('SWAGGER_UI', 'true') === 'true',
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
