// Normalizes a URL path prefix for use as a mount point:
//   '/'  → ''   (root — represented as empty string internally)
//   '/docs/'  → '/docs'
//   'docs'    → '/docs'  (adds leading slash)
//   ''        → ''
export function normalizeMountPath(raw) {
  let p = (raw ?? '').trim();
  if (!p) return '';
  if (!p.startsWith('/')) p = '/' + p;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p === '/' ? '' : p;
}
