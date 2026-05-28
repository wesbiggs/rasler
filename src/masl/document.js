import * as dagCbor from '@ipld/dag-cbor';
import { computeMaslCid } from '../crypto/cid.js';

// MASL link format: { "$link": cidString }
function link(cidString) {
  return { $link: cidString };
}

function linkCid(linkObj) {
  return linkObj?.$link ?? null;
}

// HTTP header keys that MASL documents may carry and that nodes must forward when serving.
const HTTP_HEADER_KEYS = [
  'content-type',
  'content-disposition',
  'content-encoding',
  'content-language',
];

// Collect all present HTTP header fields from a doc or resource entry object.
function httpHeaders(obj) {
  const headers = {};
  for (const key of HTTP_HEADER_KEYS) {
    if (obj[key] != null) headers[key] = obj[key];
  }
  if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
  return headers;
}

export async function createSingleMasl({
  name, type, size, dataCid,
  contentEncoding, contentLanguage,
}) {
  const doc = {
    name,
    type,
    'content-length': size,
    src: link(dataCid),
    'content-type': type,
    'content-disposition': `inline; filename="${name}"`,
    ...(contentEncoding != null ? { 'content-encoding': contentEncoding } : {}),
    ...(contentLanguage != null ? { 'content-language': contentLanguage } : {}),
  };
  const cborBytes = dagCbor.encode(doc);
  const maslCid = await computeMaslCid(cborBytes);
  return { doc, cborBytes, maslCid };
}

export async function createBundleMasl({ name, resources, prevMaslCid = null }) {
  // resources: Array of { path, cid, size, contentType, contentDisposition?,
  //                        contentEncoding?, contentLanguage? }
  const resourceMap = {};
  for (const { path, cid, size, contentType, contentDisposition, contentEncoding, contentLanguage } of resources) {
    resourceMap[path] = {
      src: link(cid),
      'content-length': size,
      'content-type': contentType ?? 'application/octet-stream',
      ...(contentDisposition != null ? { 'content-disposition': contentDisposition } : {}),
      ...(contentEncoding != null   ? { 'content-encoding': contentEncoding }   : {}),
      ...(contentLanguage != null   ? { 'content-language': contentLanguage }   : {}),
    };
  }
  const doc = {
    name,
    ...(prevMaslCid != null ? { prev: link(prevMaslCid) } : {}),
    resources: resourceMap,
  };
  const cborBytes = dagCbor.encode(doc);
  const maslCid = await computeMaslCid(cborBytes);
  return { doc, cborBytes, maslCid };
}

export function parseMasl(cborBytes) {
  return dagCbor.decode(cborBytes);
}

// Returns [{ cid: string, size: number|null }] for all directly linked data CIDs.
export function maslLinkedCids(doc) {
  const results = [];
  if (doc.src) {
    const cid = linkCid(doc.src);
    if (cid) results.push({ cid, size: doc['content-length'] ?? null });
  } else if (doc.resources) {
    for (const entry of Object.values(doc.resources)) {
      if (entry && typeof entry === 'object') {
        const cid = linkCid(entry.src);
        if (cid) results.push({ cid, size: entry['content-length'] ?? null });
      }
    }
  }
  return results;
}

// Returns HTTP headers to set when serving a single-mode MASL CID or a data CID
// whose MASL wrapper is known.
export function maslContentHeaders(doc) {
  return httpHeaders(doc);
}

export function maslIsBundle(doc) {
  return Boolean(doc.resources);
}

// Returns true if bytes appear to be a MASL document (dag-cbor map with src.$link
// or a resources map whose entries have src.$link). Used to reject MASL uploads
// from POST /pin, which only accepts raw data files.
export function isMaslDoc(bytes) {
  try {
    const doc = dagCbor.decode(bytes);
    if (!doc || typeof doc !== 'object') return false;
    if (doc.src?.$link != null) return true;
    if (doc.resources && typeof doc.resources === 'object') {
      return Object.values(doc.resources).some(e => e?.src?.$link != null);
    }
    return false;
  } catch {
    return false;
  }
}

// Finds the first resource entry in a bundle whose src CID matches dataCid,
// and returns its HTTP headers. Used to surface content-type for path-free
// data CID requests backed by a bundle MASL rather than a single MASL.
export function findBundleHeadersForCid(doc, dataCid) {
  if (!doc.resources) return null;
  for (const entry of Object.values(doc.resources)) {
    if (entry?.src?.$link === dataCid) return httpHeaders(entry);
  }
  return null;
}

// Returns { cid, headers } for the given bundle path, or null if not found.
// headers is ready to pass directly to res.set().
export function resolveBundleEntry(doc, pathSuffix) {
  if (!doc.resources) return null;
  const key = pathSuffix || '/';
  const entry = doc.resources[key];
  if (!entry) return null;
  const cid = linkCid(entry.src);
  if (!cid) return null;
  return { cid, headers: httpHeaders(entry) };
}

// Convenience wrapper — returns only the CID string.
export function resolveBundlePath(doc, pathSuffix) {
  return resolveBundleEntry(doc, pathSuffix)?.cid ?? null;
}
