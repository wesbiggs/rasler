import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, createReadStream } from 'fs';
import { join } from 'path';

function blobPath(dataDir, cid) {
  // Use chars [-3, -2] of the CID as the shard directory (e.g. "nq" for ...vnq4).
  // The first two characters of every CIDv1 base32 string are always "ba", so
  // sharding by prefix gives no distribution benefit.
  const shard = cid.slice(-3, -1);
  return join(dataDir, 'blobs', shard, cid);
}

export function writeContent(dataDir, cid, bytes) {
  const path = blobPath(dataDir, cid);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
}

export function readContent(dataDir, cid) {
  const path = blobPath(dataDir, cid);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

export function deleteContent(dataDir, cid) {
  const path = blobPath(dataDir, cid);
  if (existsSync(path)) unlinkSync(path);
}

export function hasContent(dataDir, cid) {
  return existsSync(blobPath(dataDir, cid));
}

export function readContentStream(dataDir, cid) {
  const path = blobPath(dataDir, cid);
  if (!existsSync(path)) return null;
  return createReadStream(path);
}

export function readContentStreamFromPath(absolutePath) {
  if (!existsSync(absolutePath)) return null;
  return createReadStream(absolutePath);
}

export function readContentFromPath(absolutePath) {
  if (!existsSync(absolutePath)) return null;
  return readFileSync(absolutePath);
}
