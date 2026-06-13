import { Router } from 'express';
import {
  parseMasl,
  maslContentHeaders,
  maslIsBundle,
  resolveBundleEntry,
  maslLinkedCids,
  findBundleHeadersForCid,
} from '../masl/document.js';
import { isMaslCid, cidToUnencodedDigest } from '../crypto/cid.js';

// Determine the path suffix after the CID in the request URL.
// Returns '' for the path-free form (no trailing slash or path segment),
// '/' for a trailing-slash-only request, '/style.css' for non-root, etc.
// Using req.path directly avoids the ambiguity in how Express 5 populates
// req.params.path for trailing-slash-only URLs.
function getPathAfterCid(req, cid) {
  const cidPrefix = '/.well-known/rasl/' + cid;
  return req.path.startsWith(cidPrefix) ? req.path.slice(cidPrefix.length) : '';
}

// Streams a data CID's bytes to the response. Uses getContentStream so that
// static (filesystem-backed) entries are served without copying to memory.
function pipeContent(store, cid, res, _next) {
  const result = store.getContentStream(cid);
  if (!result) return res.status(502).json({ error: 'Content unavailable' });
  res.set('content-length', String(result.meta.size));
  res.set('unencoded-digest', cidToUnencodedDigest(cid));
  res.status(200);
  result.stream.pipe(res);
}

// Base RASL router: serves locally held content. On miss, calls next() so
// overlay routing middleware (or a 404 terminator) can take over.
export function makeRaslRouter({ store }) {
  const router = Router();

  function handle(req, res, next) {
    const { cid } = req.params;
    const meta = store.getContentMeta(cid);
    if (!meta) return next();

    store.recordRequest(cid);

    const afterCid = getPathAfterCid(req, cid);
    const isPathFree = afterCid === '';

    if (isPathFree) {
      // Path-free form: always raw bytes. No MASL path resolution.
      if (isMaslCid(cid)) {
        // MASL CIDs are always in the blob store (never static).
        const entry = store.getContent(cid);
        if (!entry) return next();
        res.set({ 'content-type': 'application/octet-stream' });
        res.set('unencoded-digest', cidToUnencodedDigest(cid));
        return res.status(200).send(entry.bytes);
      }
      // Data CID: surface the MASL-derived Content-Type when available.
      // This is content negotiation, not path resolution. For bundle MASLs
      // (used by static roots), the content-type lives on the resource entry,
      // not the top-level document.
      let headers = { 'content-type': 'application/octet-stream' };
      if (meta.masl_cid) {
        const maslEntry = store.getContent(meta.masl_cid);
        if (maslEntry) {
          try {
            const doc = parseMasl(maslEntry.bytes);
            headers = maslIsBundle(doc)
              ? (findBundleHeadersForCid(doc, cid) ?? headers)
              : maslContentHeaders(doc);
          } catch { /* ignore */ }
        }
      }
      res.set(headers);
      return pipeContent(store, cid, res, next);
    }

    // Path-bearing form: resolve path against MASL document structure.
    // afterCid always begins with '/', e.g. '/', '/style.css', '/a/b/c.html'.
    const path = afterCid;

    if (isMaslCid(cid)) {
      const entry = store.getContent(cid);
      if (!entry) return next();
      let doc;
      try { doc = parseMasl(entry.bytes); } catch {
        return res.status(500).json({ error: 'Invalid MASL document' });
      }

      if (maslIsBundle(doc)) {
        // Bundle Mode: look up path in the resources map.
        const resolved = resolveBundleEntry(doc, path);
        if (!resolved) return res.status(404).json({ error: 'Not found' });
        store.recordRequest(resolved.cid);
        res.set(resolved.headers);
        return pipeContent(store, resolved.cid, res, next);
      }

      // Single Mode: has src but no resources. Only path '/' is valid.
      const links = maslLinkedCids(doc);
      const srcCid = links.length > 0 ? links[0].cid : null;
      if (srcCid) {
        if (path !== '/') return res.status(404).json({ error: 'Not found' });
        store.recordRequest(srcCid);
        res.set(maslContentHeaders(doc));
        return pipeContent(store, srcCid, res, next);
      }

      // Other DRISL map (neither resources nor src): fall through to non-MASL handling.
    }

    // Non-MASL CID (or unrecognised DRISL map): only path '/' returns raw bytes;
    // any other path is not found.
    if (path !== '/') return res.status(404).json({ error: 'Not found' });
    res.set({ 'content-type': 'application/octet-stream' });
    return pipeContent(store, cid, res, next);
  }

  router.get('/.well-known/rasl/:cid', handle);
  router.get('/.well-known/rasl/:cid/*path', handle);
  router.head('/.well-known/rasl/:cid', handle);
  router.head('/.well-known/rasl/:cid/*path', handle);

  return router;
}

// Terminator: turns a fully-fallthrough RASL request into a 404.
export function makeRaslNotFoundHandler() {
  const router = Router();
  const notFound = (req, res) => res.status(404).json({ error: 'Not found' });
  router.get('/.well-known/rasl/:cid', notFound);
  router.get('/.well-known/rasl/:cid/*path', notFound);
  router.head('/.well-known/rasl/:cid', notFound);
  router.head('/.well-known/rasl/:cid/*path', notFound);
  return router;
}
