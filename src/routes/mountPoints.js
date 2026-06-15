import { Router } from 'express';
import { realpathSync } from 'fs';
import { parseMasl, resolveBundleEntry } from '../masl/document.js';
import { cidToUnencodedDigest } from '../crypto/cid.js';
import { OPERATOR_SECRET_HEADER } from '../middleware/auth.js';

function findMountPoint(mountPoints, hostname, path) {
  for (const mp of mountPoints) {
    if (mp.hostname !== '' && mp.hostname !== hostname) continue;
    if (mp.prefix === '' || path === mp.prefix || path.startsWith(mp.prefix + '/')) {
      return mp;
    }
  }
  return null;
}

export function makeMountPointRouter({ store, mountPoints, selfOrigin }) {
  const router = Router();

  router.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/.well-known/rasl/')) return next();
    if (req.headers[OPERATOR_SECRET_HEADER]) return next();

    let maslCid;
    let maslPath;

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

    const maslEntry = await store.getContent(maslCid);
    if (!maslEntry) return res.status(503).json({ error: 'MASL unavailable' });

    let doc;
    try { doc = parseMasl(maslEntry.bytes); } catch {
      return res.status(500).json({ error: 'Invalid MASL document' });
    }

    const resolved = resolveBundleEntry(doc, maslPath);
    if (!resolved) return res.status(404).send('Not found');

    await store.recordRequest(maslCid);
    await store.recordRequest(resolved.cid);

    const result = await store.getContentStream(resolved.cid);
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
