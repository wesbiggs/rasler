import { Router } from 'express';
import { realpathSync } from 'fs';
import { parseMasl, resolveBundleEntry } from '../masl/document.js';
import { cidToUnencodedDigest } from '../crypto/cid.js';

// Serves content by resolving the request path against the bundle MASL for
// the matching virtual host. Sits before the RASL router so browser clients
// can use normal URLs; RASL paths are passed through unchanged.
//
// The MASL CID is read from store.staticRootMasls on every request, so it
// reflects the current indexed version automatically after any re-index.
export function makeVirtualHostRouter({ store, virtualHosts }) {
  const router = Router();

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Leave RASL retrieval paths to the RASL router.
    if (req.path.startsWith('/.well-known/rasl/')) return next();

    // Runtime mapping (set via operator API) takes priority over static-root mapping.
    let maslCid = store.runtimeVirtualHosts.get(req.hostname) ?? null;

    if (!maslCid) {
      const configuredPath = virtualHosts.get(req.hostname);
      if (!configuredPath) return next();

      let realRoot;
      try { realRoot = realpathSync(configuredPath); } catch { return next(); }

      maslCid = store.staticRootMasls.get(realRoot) ?? null;
      if (!maslCid) return res.status(503).json({ error: 'Virtual host not yet indexed' });
    }

    const maslEntry = store.getContent(maslCid);
    if (!maslEntry) return res.status(503).json({ error: 'MASL unavailable' });

    let doc;
    try { doc = parseMasl(maslEntry.bytes); } catch {
      return res.status(500).json({ error: 'Invalid MASL document' });
    }

    const resolved = resolveBundleEntry(doc, req.path || '/');
    if (!resolved) return res.status(404).send('Not found');

    store.recordRequest(maslCid);
    store.recordRequest(resolved.cid);

    const result = store.getContentStream(resolved.cid);
    if (!result) return res.status(502).json({ error: 'Content unavailable' });

    res.set(resolved.headers);
    res.set('content-length', String(result.meta.size));
    res.set('unencoded-digest', cidToUnencodedDigest(resolved.cid));
    res.status(200);
    result.stream.pipe(res);
  });

  return router;
}
