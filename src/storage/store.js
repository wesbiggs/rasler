import { sortMountPoints } from '../util/parseJsonConfig.js';
import { realpathSync } from 'fs';
import { sep } from 'path';

export class Store {
  // db: DbAdapter (see local-db.js for the interface)
  // blobs: BlobBackend (see local-blobs.js for the interface)
  constructor(db, blobs, totalCapacity, { staticRoots = [] } = {}) {
    this.db = db;
    this.blobs = blobs;
    this.totalCapacity = totalCapacity;
    // Pre-resolve static roots once so symlink checks at serve time are fast.
    this._realStaticRoots = staticRoots.map(r => {
      const dir = typeof r === 'string' ? r : r.directory;
      try { return realpathSync(dir); } catch { return dir; }
    });
    // Populated by indexStaticRoot after each root is indexed. Maps realpath → maslCid.
    this.staticRootMasls = new Map();
    // Runtime mount point mappings set via operator API. Persisted in the db adapter.
    // Array of {hostname, prefix, maslCid} — hostname='' means any host.
    // Callers that use an async db adapter must call store.loadMountPoints() after construction.
    const mpResult = db.listMountPoints();
    const rows = Array.isArray(mpResult)
      ? mpResult
      : []; // async adapters return a Promise; callers must await loadMountPoints()
    this.runtimeMountPoints = rows.map(
      row => ({ hostname: row.hostname, prefix: row.mount_path, maslCid: row.masl_cid })
    );
    sortMountPoints(this.runtimeMountPoints);
  }

  // Must be called after construction when using an async db adapter (e.g. D1).
  async loadMountPoints() {
    const rows = await this.db.listMountPoints();
    this.runtimeMountPoints = rows.map(
      row => ({ hostname: row.hostname, prefix: row.mount_path, maslCid: row.masl_cid })
    );
    sortMountPoints(this.runtimeMountPoints);
  }

  async putContent(cid, bytes, { maslCid = null, pinned = false } = {}) {
    await this.blobs.put(cid, bytes);
    await this.db.putContent(cid, { maslCid, size: bytes.length, pinned, lastRequested: null });
  }

  async getContent(cid) {
    const meta = await this.db.getContent(cid);
    if (!meta) return null;
    const bytes = await this.blobs.get(cid, meta);
    if (!bytes) return null;
    return { bytes, meta };
  }

  async getContentStream(cid) {
    const meta = await this.db.getContent(cid);
    if (!meta) return null;
    if (meta.source_path) {
      let realFile;
      try { realFile = realpathSync(meta.source_path); } catch { return null; }
      const allowed = this._realStaticRoots.some(
        root => realFile === root || realFile.startsWith(root + sep)
      );
      if (!allowed) return null;
    }
    const stream = await this.blobs.getStream(cid, meta);
    if (!stream) return null;
    return { stream, meta };
  }

  async getContentMeta(cid) {
    return this.db.getContent(cid);
  }

  async hasContent(cid) {
    return this.db.hasContent(cid);
  }

  async listContent() {
    return this.db.listContent();
  }

  async countContent() {
    return this.db.countContent();
  }

  async listContentPage(limit, cursor) {
    return this.db.listContentPage(limit, cursor);
  }

  async deleteContent(cid) {
    const meta = await this.db.getContent(cid);
    if (!meta?.source_path) await this.blobs.delete(cid);
    await this.db.deleteContent(cid);
  }

  async recordRequest(cid) {
    await this.db.recordRequest(cid);
  }

  async setPinned(cid, pinned) {
    await this.db.setPinned(cid, pinned);
  }

  async getPoolUsed() {
    return this.db.getTotalPoolSize();
  }

  async getPinnedUsed() {
    return this.db.getTotalPinnedSize();
  }

  async getPoolAvailable() {
    const pool = await this.db.getTotalPoolSize();
    const pinned = await this.db.getTotalPinnedSize();
    return Math.max(0, this.totalCapacity - pool - pinned);
  }

  async countPinned() {
    return this.db.countPinned();
  }

  async setMountPoint(hostname, prefix, maslCid) {
    await this.db.setMountPoint(hostname, prefix, maslCid);
    this.runtimeMountPoints = this.runtimeMountPoints.filter(
      mp => !(mp.hostname === hostname && mp.prefix === prefix)
    );
    this.runtimeMountPoints.push({ hostname, prefix, maslCid });
    sortMountPoints(this.runtimeMountPoints);
  }

  async deleteMountPoint(hostname, prefix) {
    await this.db.deleteMountPoint(hostname, prefix);
    this.runtimeMountPoints = this.runtimeMountPoints.filter(
      mp => !(mp.hostname === hostname && mp.prefix === prefix)
    );
  }

  async evictIfNeeded(requiredBytes) {
    if (await this.getPoolAvailable() >= requiredBytes) return true;
    const cid = await this.db.findEvictionCandidate();
    if (!cid) return false;
    await this.deleteContent(cid);
    return true;
  }

  // Static-content methods (local Node.js deployment only).
  async putStaticContent(cid, opts) {
    await this.db.putStaticContent(cid, opts);
  }

  async getContentBySourcePath(sourcePath) {
    return this.db.getContentBySourcePath(sourcePath);
  }

  async listStaticContent() {
    return this.db.listStaticContent();
  }
}
