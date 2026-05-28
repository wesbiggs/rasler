import {
  dbPutContent, dbGetContent, dbHasContent, dbListContent, dbDeleteContent,
  dbRecordRequest, dbSetPinned, dbGetTotalPoolSize, dbGetTotalPinnedSize,
  dbCountPinned, dbCountContent, dbListContentPage,
  dbSetVirtualHost, dbDeleteVirtualHost, dbListVirtualHosts,
} from './db.js';
import {
  writeContent, readContent, readContentFromPath,
  readContentStream, readContentStreamFromPath, deleteContent,
} from './files.js';
import { realpathSync } from 'fs';
import { sep } from 'path';

// Default eviction policy: oldest unpinned by last_requested (LRU).
// An overlay can supply a network-aware policy that considers
// replica counts and primary-holder status.
function defaultFindEvictionCandidate(store) {
  const row = store.db.prepare(`
    SELECT cid FROM content
    WHERE pinned = 0
    ORDER BY last_requested ASC NULLS FIRST
    LIMIT 1
  `).get();
  return row?.cid ?? null;
}

export class Store {
  constructor(db, dataDir, totalCapacity, { findEvictionCandidate, staticRoots = [] } = {}) {
    this.db = db;
    this.dataDir = dataDir;
    this.totalCapacity = totalCapacity;
    this._findEvictionCandidate = findEvictionCandidate ?? defaultFindEvictionCandidate;
    // Pre-resolve static roots once so symlink checks at serve time are fast.
    this._realStaticRoots = staticRoots.map(r => {
      try { return realpathSync(r); } catch { return r; }
    });
    // Populated by indexStaticRoot after each root is indexed. Maps realpath → maslCid.
    this.staticRootMasls = new Map();
    // Runtime virtual host mappings set via operator API. Persisted in SQLite.
    // Maps hostname → maslCid. Takes priority over staticRootMasls in vhost routing.
    this.runtimeVirtualHosts = new Map(
      dbListVirtualHosts(db).map(row => [row.hostname, row.masl_cid])
    );
  }

  putContent(cid, bytes, { maslCid = null, pinned = false } = {}) {
    writeContent(this.dataDir, cid, bytes);
    dbPutContent(this.db, cid, {
      maslCid,
      size: bytes.length,
      pinned,
      lastRequested: null,
    });
  }

  getContent(cid) {
    const meta = dbGetContent(this.db, cid);
    if (!meta) return null;
    const bytes = meta.source_path
      ? readContentFromPath(meta.source_path)
      : readContent(this.dataDir, cid);
    if (!bytes) return null;
    return { bytes, meta };
  }

  // Returns { stream: ReadStream, meta } for efficient large-file serving,
  // or null if the content is unavailable. For static entries, verifies
  // that source_path still resolves to a path under a configured static root.
  getContentStream(cid) {
    const meta = dbGetContent(this.db, cid);
    if (!meta) return null;
    if (meta.source_path) {
      let realFile;
      try { realFile = realpathSync(meta.source_path); } catch { return null; }
      const allowed = this._realStaticRoots.some(
        root => realFile === root || realFile.startsWith(root + sep)
      );
      if (!allowed) return null;
      const stream = readContentStreamFromPath(meta.source_path);
      if (!stream) return null;
      return { stream, meta };
    }
    const stream = readContentStream(this.dataDir, cid);
    if (!stream) return null;
    return { stream, meta };
  }

  getContentMeta(cid) {
    return dbGetContent(this.db, cid);
  }

  hasContent(cid) {
    return dbHasContent(this.db, cid);
  }

  listContent() {
    return dbListContent(this.db);
  }

  countContent() {
    return dbCountContent(this.db);
  }

  listContentPage(limit, cursor) {
    return dbListContentPage(this.db, limit, cursor);
  }

  deleteContent(cid) {
    const meta = dbGetContent(this.db, cid);
    // Static content: bytes live on operator's filesystem; only remove the DB record.
    if (!meta?.source_path) deleteContent(this.dataDir, cid);
    dbDeleteContent(this.db, cid);
  }

  recordRequest(cid) {
    dbRecordRequest(this.db, cid);
  }

  setPinned(cid, pinned) {
    dbSetPinned(this.db, cid, pinned);
  }

  getPoolUsed() {
    return dbGetTotalPoolSize(this.db);
  }

  getPinnedUsed() {
    return dbGetTotalPinnedSize(this.db);
  }

  getPoolAvailable() {
    return Math.max(0, this.totalCapacity - this.getPoolUsed() - this.getPinnedUsed());
  }

  countPinned() {
    return dbCountPinned(this.db);
  }

  // Evicts one CID if needed to free requiredBytes. Returns true if eviction
  // was performed or not needed, false if impossible. The eviction policy is
  // injected via the constructor; replica-row cleanup happens automatically
  // via FK cascade on the replicas table.
  setVirtualHost(hostname, maslCid) {
    dbSetVirtualHost(this.db, hostname, maslCid);
    this.runtimeVirtualHosts.set(hostname, maslCid);
  }

  deleteVirtualHost(hostname) {
    dbDeleteVirtualHost(this.db, hostname);
    this.runtimeVirtualHosts.delete(hostname);
  }

  evictIfNeeded(requiredBytes) {
    if (this.getPoolAvailable() >= requiredBytes) return true;
    const cid = this._findEvictionCandidate(this);
    if (!cid) return false;
    this.deleteContent(cid);
    return true;
  }
}
