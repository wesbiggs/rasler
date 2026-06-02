import { resolve } from 'node:path';
import { normalizeMountPath } from './normalizeMountPath.js';

// Parses the staticRoots array from rasler.config.json.
// Each entry may be a string (path only) or an object { path, watch?, ignore? }.
// Returns an array of { directory, watch, ignore }.
export function parseJsonStaticRoots(entries = []) {
  return entries.flatMap(entry => {
    if (typeof entry === 'string') {
      const p = entry.trim();
      if (!p) return [];
      return [{ directory: resolve(p), watch: false, ignore: [] }];
    }
    if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim()) {
      return [{
        directory: resolve(entry.path.trim()),
        watch: entry.watch === true,
        ignore: Array.isArray(entry.ignore)
          ? entry.ignore.filter(s => typeof s === 'string')
          : [],
      }];
    }
    return [];
  });
}

// Parses the mountPoints array from rasler.config.json.
// Each entry: { hostname, prefix?, directory }.
// Returns an array of { hostname, prefix, directory } sorted longest-prefix-first.
export function parseJsonMountPoints(entries = []) {
  const points = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const hostname = typeof entry.hostname === 'string' ? entry.hostname.trim() : '';
    const directory = typeof entry.directory === 'string' ? entry.directory.trim() : '';
    if (!hostname || !directory) continue;
    points.push({
      hostname,
      prefix: normalizeMountPath(entry.prefix || ''),
      directory: resolve(directory),
    });
  }
  points.sort((a, b) => b.prefix.length - a.prefix.length);
  return points;
}
