import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { parseSize } from './util/parseSize.js';
import { required, optional } from './util/env.js';
import { normalizeMountPath } from './util/normalizeMountPath.js';
import { loadRaslerConfig } from './util/loadRaslerConfig.js';
import { parseJsonStaticRoots, parseJsonMountPoints } from './util/parseJsonConfig.js';

export { parseSize, normalizeMountPath };

const port = parseInt(optional('PORT', '3000'), 10);

// Accept a bare hostname (e.g. "node1.example.com") for backwards compat and
// default it to https://. A full origin (e.g. "http://localhost:3000") is used
// as-is so the correct protocol appears in Link: rel="duplicate" headers.
const originRaw = optional('ORIGIN', `http://localhost:${port}`);
const originUrl = new URL(/^https?:\/\//.test(originRaw) ? originRaw : `https://${originRaw}`);

const raslerConfig = loadRaslerConfig();

const mountPoints = parseJsonMountPoints(raslerConfig?.mountPoints ?? []);

// Static roots from JSON config, plus any directories referenced by mountPoints.
const staticRoots = parseJsonStaticRoots(raslerConfig?.staticRoots ?? []);
const mountPointDirs = new Set(mountPoints.map(mp => mp.directory));
for (const dir of mountPointDirs) {
  const existing = staticRoots.find(r => r.directory === dir);
  if (!existing) {
    staticRoots.push({ directory: dir, watch: false, ignore: [], generateMasl: true });
  } else if (!existing.generateMasl) {
    // Mount-point directories always need a bundle MASL for serving.
    existing.generateMasl = true;
  }
}

// Implicit ./public mount: if the directory exists and no root-level mount is
// already configured for the origin domain, serve it at the document root.
const publicDir = resolve(process.cwd(), 'public');
if (existsSync(publicDir)) {
  if (!staticRoots.some(r => r.directory === publicDir)) {
    staticRoots.push({ directory: publicDir, watch: false, ignore: [], generateMasl: true });
  }
  if (!mountPoints.some(mp => (mp.hostname === originUrl.hostname || mp.hostname === '') && mp.prefix === '')) {
    mountPoints.push({ hostname: originUrl.hostname, prefix: '', directory: publicDir });
    mountPoints.sort((a, b) => b.prefix.length - a.prefix.length);
  }
}

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
  operatorCorsOrigins: Array.isArray(raslerConfig?.operatorCorsOrigins)
    ? raslerConfig.operatorCorsOrigins.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
    : [],
  // Array of { hostname, prefix, directory } sorted longest-prefix-first.
  mountPoints,
  // Array of { directory, watch, ignore } for all static roots (includes mount
  // point directories and the implicit ./public if it exists).
  staticRoots,
  // Maximum number of MASL versions to keep pinned per static root (including
  // the current one). Older entries are unpinned and become eligible for LRU
  // eviction. Unset or 0 means no limit.
  staticMaxHistory: (() => {
    const n = parseInt(raslerConfig?.staticMaxHistory ?? 0, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  })(),
});

export default config;
