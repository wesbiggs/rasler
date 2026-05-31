import { Router } from 'express';
import { realpathSync } from 'fs';
import { parseMasl, resolveBundleEntry } from '../masl/document.js';
import { cidToUnencodedDigest } from '../crypto/cid.js';

// Returns the first mount point whose hostname and prefix match the request,
// or null. mountPoints must be sorted longest-prefix-first.
function findMountPoint(mountPoints, hostname, path) {
  for (const mp of mountPoints) {
    if (mp.hostname !== hostname) continue;
    if (mp.prefix === '' || path === mp.prefix || path.startsWith(mp.prefix + '/')) {
      return mp;
    }
  }
  return null;
}

// Serves content by resolving the request path against the bundle MASL for
// the matching mount point. Sits before the RASL router so browser clients
// can use normal URLs; RASL paths are passed through unchanged.
//
// The MASL CID is read from store.staticRootMasls on every request, so it
// reflects the current indexed version automatically after any re-index.
export function makeMountPointRouter({ store, mountPoints, selfOrigin }) {
  const router = Router();

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Leave RASL retrieval paths to the RASL router.
    if (req.path.startsWith('/.well-known/rasl/')) return next();

    let maslCid = null;
    let maslPath = req.path || '/';

    // Runtime mappings take priority over static-root mappings.
    const runtimeMp = findMountPoint(store.runtimeMountPoints, req.hostname, req.path);
    if (runtimeMp) {
      maslCid = runtimeMp.maslCid;
      maslPath = runtimeMp.prefix ? req.path.slice(runtimeMp.prefix.length) || '/' : req.path;
    } else {
      const staticMp = findMountPoint(mountPoints, req.hostname, req.path);
      if (!staticMp) return next();

      let realRoot;
      try { realRoot = realpathSync(staticMp.directory); } catch { return next(); }

      maslCid = store.staticRootMasls.get(realRoot) ?? null;
      if (!maslCid) return res.status(503).json({ error: 'Mount point not yet indexed' });

      maslPath = staticMp.prefix ? req.path.slice(staticMp.prefix.length) || '/' : req.path;
    }

    const maslEntry = store.getContent(maslCid);
    if (!maslEntry) return res.status(503).json({ error: 'MASL unavailable' });

    let doc;
    try { doc = parseMasl(maslEntry.bytes); } catch {
      return res.status(500).json({ error: 'Invalid MASL document' });
    }

    const resolved = resolveBundleEntry(doc, maslPath);
    if (!resolved) return res.status(404).send('Not found');

    store.recordRequest(maslCid);
    store.recordRequest(resolved.cid);

    const result = store.getContentStream(resolved.cid);
    if (!result) return res.status(502).json({ error: 'Content unavailable' });

    res.set(resolved.headers);
    res.set('content-length', String(result.meta.size));
    res.set('unencoded-digest', cidToUnencodedDigest(resolved.cid));
    res.set('link', `<${selfOrigin}/.well-known/rasl/${maslCid}${maslPath}>; rel="duplicate"`);
    res.status(200);
    result.stream.pipe(res);
  });

  return router;
}
