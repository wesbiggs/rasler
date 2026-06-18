import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, basename, dirname, sep } from 'node:path';
import micromatch from 'micromatch';
import { computeDataCid } from './crypto/cid.js';
import { createBundleMasl, parseMasl } from './masl/document.js';
import { mimeType } from './util/mime.js';

function pruneHistory(store, prevMaslCid, maxHistory) {
  let cid = prevMaslCid;
  let depth = 2;
  while (cid) {
    const entry = store.db.getContent(cid);
    if (!entry) break;
    if (depth > maxHistory) store.db.setPinned(cid, false);
    try {
      cid = parseMasl(store.blobs.get(cid, entry))?.prev?.$link ?? null;
    } catch { break; }
    depth++;
  }
}

async function* walkDir(dir, rootDir, ignore) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (ignore.length > 0) {
      const rel = relative(rootDir, full).replace(/\\/g, '/');
      if (micromatch.isMatch(rel, ignore)) continue;
    }
    if (entry.isDirectory()) yield* walkDir(full, rootDir, ignore);
    else if (entry.isFile()) yield full;
  }
}

export async function indexStaticRoot(rootPath, store, { maxHistory = null, ignore = [], generateMasl = true } = {}) {
  const realRoot = await realpath(rootPath);
  const fileInfos = [];
  const visitedPaths = new Set();
  let changed = false;

  for await (const filePath of walkDir(realRoot, realRoot, ignore)) {
    let realFile;
    try { realFile = await realpath(filePath); } catch { continue; }
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) continue;

    visitedPaths.add(realFile);

    const { size, mtimeMs } = await stat(realFile);
    const mtime = Math.round(mtimeMs);

    const existing = store.db.getContentBySourcePath(realFile);
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

  for (const entry of store.db.listStaticContent()) {
    if (entry.source_path?.startsWith(realRoot + sep) && !visitedPaths.has(entry.source_path)) {
      changed = true;
      store.db.deleteContent(entry.cid);
    }
  }

  if (fileInfos.length === 0) return null;

  if (!generateMasl) {
    if (!changed) return null;
    const seen = new Set();
    for (const { cid, size, mtime, realPath } of fileInfos) {
      if (!seen.has(cid)) {
        seen.add(cid);
        store.db.putStaticContent(cid, { maslCid: null, size, sourcePath: realPath, sourceMtime: mtime });
      }
    }
    return null;
  }

  const prevEntry = store.db.listStaticContent()
    .find(e => e.source_path?.startsWith(realRoot + sep));
  const prevMaslCid = prevEntry?.masl_cid ?? null;

  if (!changed && prevMaslCid) {
    store.staticRootMasls.set(realRoot, prevMaslCid);
    return prevMaslCid;
  }

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

  store.db.putContent(maslCid, { maslCid: null, size: cborBytes.length, pinned: true, lastRequested: null });
  store.blobs.put(maslCid, Buffer.from(cborBytes));
  store.staticRootMasls.set(realRoot, maslCid);

  if (maxHistory != null && prevMaslCid) pruneHistory(store, prevMaslCid, maxHistory);

  const seen = new Set();
  for (const { cid, size, mtime, realPath } of fileInfos) {
    if (!seen.has(cid)) {
      seen.add(cid);
      store.db.putStaticContent(cid, { maslCid, size, sourcePath: realPath, sourceMtime: mtime });
    }
  }

  return maslCid;
}

export async function indexStaticRoots(staticRoots, store, { maxHistory = null } = {}) {
  for (const root of staticRoots) {
    const { directory, ignore = [], generateMasl = true } = root;
    try {
      const maslCid = await indexStaticRoot(directory, store, { maxHistory, ignore, generateMasl });
      if (maslCid) {
        console.log(`Static root indexed: ${directory} → MASL ${maslCid}`);
      } else if (!generateMasl) {
        console.log(`Static root indexed: ${directory} (blobs only, no MASL)`);
      } else {
        console.warn(`Static root empty, skipped: ${directory}`);
      }
    } catch (err) {
      console.error(`Failed to index static root ${directory}: ${err.message}`);
    }
  }
}
