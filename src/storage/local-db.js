import {
  dbPutContent, dbGetContent, dbHasContent, dbListContent, dbDeleteContent,
  dbRecordRequest, dbSetPinned, dbGetTotalPoolSize, dbGetTotalPinnedSize,
  dbCountPinned, dbCountContent, dbListContentPage,
  dbSetMountPoint, dbDeleteMountPoint, dbListMountPoints,
  dbPutStaticContent, dbGetContentBySourcePath, dbListStaticContent,
} from './db.js';

export function makeLocalDb(db) {
  return {
    putContent: (cid, opts) => { dbPutContent(db, cid, opts); },
    getContent: (cid) => dbGetContent(db, cid),
    hasContent: (cid) => dbHasContent(db, cid),
    listContent: () => dbListContent(db),
    countContent: () => dbCountContent(db),
    listContentPage: (limit, cursor) => dbListContentPage(db, limit, cursor),
    deleteContent: (cid) => { dbDeleteContent(db, cid); },
    recordRequest: (cid) => { dbRecordRequest(db, cid); },
    setPinned: (cid, pinned) => { dbSetPinned(db, cid, pinned); },
    getTotalPoolSize: () => dbGetTotalPoolSize(db),
    getTotalPinnedSize: () => dbGetTotalPinnedSize(db),
    countPinned: () => dbCountPinned(db),
    findEvictionCandidate: () => {
      const row = db.prepare(`
        SELECT cid FROM content
        WHERE pinned = 0
        ORDER BY last_requested ASC NULLS FIRST
        LIMIT 1
      `).get();
      return row?.cid ?? null;
    },
    putStaticContent: (cid, opts) => { dbPutStaticContent(db, cid, opts); },
    getContentBySourcePath: (sourcePath) => dbGetContentBySourcePath(db, sourcePath),
    listStaticContent: () => dbListStaticContent(db),
    setMountPoint: (hostname, mountPath, maslCid) => { dbSetMountPoint(db, hostname, mountPath, maslCid); },
    deleteMountPoint: (hostname, mountPath) => { dbDeleteMountPoint(db, hostname, mountPath); },
    listMountPoints: () => dbListMountPoints(db),
  };
}
