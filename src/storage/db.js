import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { join } from 'path';

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS content (
  cid TEXT PRIMARY KEY,
  masl_cid TEXT,
  size INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  last_requested INTEGER,
  source_path TEXT,
  source_mtime INTEGER
);
CREATE TABLE IF NOT EXISTS virtual_hosts (
  hostname TEXT PRIMARY KEY,
  masl_cid TEXT NOT NULL
);
`;

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'rasler.db'));
  db.exec(BASE_SCHEMA);
  try { db.exec('ALTER TABLE content ADD COLUMN source_path TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE content ADD COLUMN source_mtime INTEGER'); } catch { /* already exists */ }
  // virtual_hosts table added in BASE_SCHEMA; IF NOT EXISTS handles existing DBs.
  return db;
}

// ---- Content ----

// pinned = 2: static filesystem-backed content. Never evicted, not counted
// toward pool or pinned capacity. source_path is the resolved absolute path.
export function dbPutStaticContent(db, cid, { maslCid = null, size, sourcePath, sourceMtime }) {
  db.prepare(`
    INSERT INTO content (cid, masl_cid, size, pinned, source_path, source_mtime, last_requested)
    VALUES (?, ?, ?, 2, ?, ?, NULL)
    ON CONFLICT(cid) DO UPDATE SET
      masl_cid = excluded.masl_cid,
      size = excluded.size,
      pinned = 2,
      source_path = excluded.source_path,
      source_mtime = excluded.source_mtime
  `).run(cid, maslCid, size, sourcePath, sourceMtime);
}

export function dbGetContentBySourcePath(db, sourcePath) {
  return db.prepare('SELECT * FROM content WHERE source_path = ?').get(sourcePath) ?? null;
}

export function dbListStaticContent(db) {
  return db.prepare('SELECT * FROM content WHERE pinned = 2').all();
}

export function dbPutContent(db, cid, { maslCid = null, size, pinned = 0, lastRequested = null }) {
  const stmt = db.prepare(`
    INSERT INTO content (cid, masl_cid, size, pinned, last_requested)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cid) DO UPDATE SET
      masl_cid = excluded.masl_cid,
      size = excluded.size,
      pinned = MAX(pinned, excluded.pinned),
      last_requested = excluded.last_requested
  `);
  stmt.run(cid, maslCid, size, pinned ? 1 : 0, lastRequested);
}

export function dbGetContent(db, cid) {
  return db.prepare('SELECT * FROM content WHERE cid = ?').get(cid) ?? null;
}

export function dbHasContent(db, cid) {
  return !!db.prepare('SELECT 1 FROM content WHERE cid = ?').get(cid);
}

export function dbListContent(db) {
  return db.prepare('SELECT * FROM content').all();
}

export function dbCountContent(db) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM content').get().cnt;
}

export function dbListContentPage(db, limit, cursor) {
  if (cursor) {
    return db.prepare('SELECT * FROM content WHERE cid > ? ORDER BY cid LIMIT ?').all(cursor, limit);
  }
  return db.prepare('SELECT * FROM content ORDER BY cid LIMIT ?').all(limit);
}

export function dbDeleteContent(db, cid) {
  db.prepare('DELETE FROM content WHERE cid = ?').run(cid);
}

export function dbRecordRequest(db, cid) {
  db.prepare('UPDATE content SET last_requested = ? WHERE cid = ?').run(Date.now(), cid);
}

export function dbSetPinned(db, cid, pinned) {
  db.prepare('UPDATE content SET pinned = ? WHERE cid = ?').run(pinned ? 1 : 0, cid);
}

export function dbGetTotalPoolSize(db) {
  const row = db.prepare('SELECT SUM(size) AS total FROM content WHERE pinned = 0').get();
  return row?.total ?? 0;
}

export function dbGetTotalPinnedSize(db) {
  const row = db.prepare('SELECT SUM(size) AS total FROM content WHERE pinned = 1').get();
  return row?.total ?? 0;
}

export function dbCountPinned(db) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM content WHERE pinned = 1').get();
  return row?.cnt ?? 0;
}

// ---- Virtual hosts ----

export function dbSetVirtualHost(db, hostname, maslCid) {
  db.prepare(`
    INSERT INTO virtual_hosts (hostname, masl_cid) VALUES (?, ?)
    ON CONFLICT(hostname) DO UPDATE SET masl_cid = excluded.masl_cid
  `).run(hostname, maslCid);
}

export function dbDeleteVirtualHost(db, hostname) {
  db.prepare('DELETE FROM virtual_hosts WHERE hostname = ?').run(hostname);
}

export function dbListVirtualHosts(db) {
  return db.prepare('SELECT hostname, masl_cid FROM virtual_hosts').all();
}
