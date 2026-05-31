import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, basename, dirname, sep } from 'node:path';
import { computeDataCid } from './crypto/cid.js';
import { createBundleMasl, parseMasl } from './masl/document.js';
import { mimeType } from './util/mime.js';
import {
  dbPutStaticContent,
  dbGetContentBySourcePath,
  dbListStaticContent,
  dbDeleteContent,
} from './storage/db.js';

// Walks the prev chain from prevMaslCid (depth 2 relative to the new MASL)
// and unpins any entry whose depth exceeds maxHistory.
function pruneHistory(store, prevMaslCid, maxHistory) {
  let cid = prevMaslCid;
  let depth = 2; // new MASL is depth 1, its prev is depth 2
  while (cid) {
    const entry = store.getContent(cid);
    if (!entry) break;
    if (depth > maxHistory) store.setPinned(cid, false);
    try {
      cid = parseMasl(entry.bytes).prev?.$link ?? null;
    } catch { break; }
    depth++;
  }
}

async function* walkDir(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full);
    else if (entry.isFile()) yield full;
  }
}

// Scans rootPath, registers each file's CID in the store's DB (with
// source_path set), generates a bundle MASL for the root, and returns the
// MASL CID. Files are never copied to the blob store. Symlinks that resolve
// outside the root are silently skipped.
//
// On repeated startups, files whose size and mtime match the stored values are
// not re-read or re-hashed. DB entries for files that no longer exist are removed.
export async function indexStaticRoot(rootPath, store, { maxHistory = null } = {}) {
  const realRoot = await realpath(rootPath);
  const fileInfos = [];
  const visitedPaths = new Set();
  let changed = false;

  for await (const filePath of walkDir(realRoot)) {
    let realFile;
    try { realFile = await realpath(filePath); } catch { continue; }
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) continue;

    visitedPaths.add(realFile);

    const { size, mtimeMs } = await stat(realFile);
    const mtime = Math.round(mtimeMs);

    // Cache hit: size and mtime both match → file unchanged → reuse stored CID.
    const existing = dbGetContentBySourcePath(store.db, realFile);
    let cid;
    if (existing && existing.size === size && existing.source_mtime === mtime) {
      cid = existing.cid;
    } else {
      changed = true;
      const bytes = await readFile(realFile);
      cid = await computeDataCid(bytes);
    }

    const contentType = mimeType(filePath);
    const relPath = '/' + relative(realRoot, filePath).replace(/\\/g, '/');
    fileInfos.push({ realPath: realFile, relPath, cid, size, mtime, contentType });
  }

  // Remove DB entries for files deleted since the last startup.
  for (const entry of dbListStaticContent(store.db)) {
    if (entry.source_path?.startsWith(realRoot + sep) && !visitedPaths.has(entry.source_path)) {
      changed = true;
      dbDeleteContent(store.db, entry.cid);
    }
  }

  if (fileInfos.length === 0) return null;

  // Find the existing MASL CID for this root (if any) to link as prev.
  const prevEntry = dbListStaticContent(store.db)
    .find(e => e.source_path?.startsWith(realRoot + sep));
  const prevMaslCid = prevEntry?.masl_cid ?? null;

  // Nothing changed — reuse the existing MASL rather than generating a new one.
  if (!changed && prevMaslCid) {
    store.staticRootMasls.set(realRoot, prevMaslCid);
    return prevMaslCid;
  }

  // Sort for deterministic MASL CIDs across restarts.
  fileInfos.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const resources = [];
  for (const { relPath, cid, size, contentType } of fileInfos) {
    resources.push({ path: relPath, cid, size, contentType });
    if (basename(relPath) === 'index.html') {
      const dir = dirname(relPath);
      resources.push({ path: dir === '/' ? '/' : dir + '/', cid, size, contentType });
    }
  }

  const name = basename(realRoot);
  const { cborBytes, maslCid } = await createBundleMasl({ name, resources, prevMaslCid });

  store.putContent(maslCid, Buffer.from(cborBytes), { pinned: true });
  store.staticRootMasls.set(realRoot, maslCid);

  if (maxHistory != null && prevMaslCid) pruneHistory(store, prevMaslCid, maxHistory);

  const seen = new Set();
  for (const { cid, size, mtime, realPath } of fileInfos) {
    if (!seen.has(cid)) {
      seen.add(cid);
      dbPutStaticContent(store.db, cid, { maslCid, size, sourcePath: realPath, sourceMtime: mtime });
    }
  }

  return maslCid;
}

export async function indexStaticRoots(staticRoots, store, { maxHistory = null } = {}) {
  for (const root of staticRoots) {
    try {
      const maslCid = await indexStaticRoot(root, store, { maxHistory });
      if (maslCid) console.log(`Static root indexed: ${root} → MASL ${maslCid}`);
      else console.warn(`Static root empty, skipped: ${root}`);
    } catch (err) {
      console.error(`Failed to index static root ${root}: ${err.message}`);
    }
  }
}
