import {
  parseMasl, maslContentHeaders, maslIsBundle,
  resolveBundleEntry, maslLinkedCids, findBundleHeadersForCid,
} from '../masl/document.js';
import { isMaslCid, cidToUnencodedDigest } from '../crypto/cid.js';

// Resolves a RASL request for the given CID and path suffix.
//
// pathSuffix is the portion of the URL after the CID:
//   ''          → path-free form (raw bytes)
//   '/'         → bundle root
//   '/foo.css'  → bundle resource
//
// Returns one of:
//   null                                             → local miss; caller should delegate (next())
//   { status, headers, bytes }                       → complete in-memory response
//   { status, headers, stream, size }                → streaming response (stream is platform-specific)
//   { status, body: { error, ...extra } }            → error response
export async function resolveRaslRequest(store, cid, pathSuffix) {
  const meta = await store.getContentMeta(cid);
  if (!meta) return null;

  await store.recordRequest(cid);

  const isPathFree = pathSuffix === '';

  if (isPathFree) {
    if (isMaslCid(cid)) {
      const entry = await store.getContent(cid);
      if (!entry) return null;
      return {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'unencoded-digest': cidToUnencodedDigest(cid),
        },
        bytes: entry.bytes,
      };
    }

    let headers = { 'content-type': 'application/octet-stream' };
    if (meta.masl_cid) {
      const maslEntry = await store.getContent(meta.masl_cid);
      if (maslEntry) {
        try {
          const doc = parseMasl(maslEntry.bytes);
          headers = maslIsBundle(doc)
            ? (findBundleHeadersForCid(doc, cid) ?? headers)
            : maslContentHeaders(doc);
        } catch { /* ignore */ }
      }
    }

    const streamResult = await store.getContentStream(cid);
    if (!streamResult) return { status: 502, body: { error: 'Content unavailable' } };
    return {
      status: 200,
      headers: { ...headers, 'unencoded-digest': cidToUnencodedDigest(cid) },
      stream: streamResult.stream,
      size: streamResult.meta.size,
    };
  }

  // Path-bearing: resolve against MASL document structure.
  const path = pathSuffix;

  if (isMaslCid(cid)) {
    const entry = await store.getContent(cid);
    if (!entry) return null;
    let doc;
    try { doc = parseMasl(entry.bytes); } catch {
      return { status: 500, body: { error: 'Invalid MASL document' } };
    }

    if (maslIsBundle(doc)) {
      const resolved = resolveBundleEntry(doc, path);
      if (!resolved) return { status: 404, body: { error: 'Not found' } };
      await store.recordRequest(resolved.cid);
      const streamResult = await store.getContentStream(resolved.cid);
      if (!streamResult) return { status: 502, body: { error: 'Content unavailable' } };
      return {
        status: 200,
        headers: { ...resolved.headers, 'unencoded-digest': cidToUnencodedDigest(resolved.cid) },
        stream: streamResult.stream,
        size: streamResult.meta.size,
      };
    }

    // Single mode: only path '/' is valid.
    const links = maslLinkedCids(doc);
    const srcCid = links.length > 0 ? links[0].cid : null;
    if (srcCid) {
      if (path !== '/') return { status: 404, body: { error: 'Not found' } };
      await store.recordRequest(srcCid);
      const streamResult = await store.getContentStream(srcCid);
      if (!streamResult) return { status: 502, body: { error: 'Content unavailable' } };
      return {
        status: 200,
        headers: { ...maslContentHeaders(doc), 'unencoded-digest': cidToUnencodedDigest(srcCid) },
        stream: streamResult.stream,
        size: streamResult.meta.size,
      };
    }
  }

  // Non-MASL CID (or unrecognised DRISL map): only path '/' returns raw bytes.
  if (path !== '/') return { status: 404, body: { error: 'Not found' } };
  const streamResult = await store.getContentStream(cid);
  if (!streamResult) return { status: 502, body: { error: 'Content unavailable' } };
  return {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'unencoded-digest': cidToUnencodedDigest(cid),
    },
    stream: streamResult.stream,
    size: streamResult.meta.size,
  };
}
