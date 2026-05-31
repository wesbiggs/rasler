import { resolve } from 'path';
import { normalizeMountPath } from './normalizeMountPath.js';

// Parses MOUNT_POINTS env string into an array of { hostname, prefix, directory }
// sorted longest-prefix-first. Skips malformed entries.
export function parseMountPoints(mountPointsStr = '') {
  const points = [];
  for (const entry of mountPointsStr.split(',').map(s => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx < 1) continue;
    const hostWithPrefix = entry.slice(0, idx).trim();
    const dirRaw = entry.slice(idx + 1).trim();
    if (!hostWithPrefix || !dirRaw) continue;
    const directory = resolve(dirRaw);
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
}

// Parses STATIC_ROOTS and MOUNT_POINTS env strings into a deduplicated array
// of absolute directory paths to index as static roots.
export function parseStaticRoots(staticRootsStr = '', mountPointsStr = '') {
  const explicit = staticRootsStr.split(',').map(s => s.trim()).filter(Boolean).map(s => resolve(s));
  const fromMounts = parseMountPoints(mountPointsStr).map(mp => mp.directory);
  return [...new Set([...explicit, ...fromMounts])];
}
