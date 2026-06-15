import {
  writeContent, readContent, readContentFromPath,
  readContentStream, readContentStreamFromPath, deleteContent,
} from './files.js';

export function makeLocalBlobs(dataDir) {
  return {
    put: (cid, bytes) => { writeContent(dataDir, cid, bytes); },
    get: (cid, meta) => {
      if (meta?.source_path) return readContentFromPath(meta.source_path);
      return readContent(dataDir, cid);
    },
    getStream: (cid, meta) => {
      if (meta?.source_path) return readContentStreamFromPath(meta.source_path);
      return readContentStream(dataDir, cid);
    },
    delete: (cid) => { deleteContent(dataDir, cid); },
  };
}
