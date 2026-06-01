# Static roots

Static roots let you serve files from existing directories without uploading them or copying bytes into the blob store. This is useful for large files or frequently-updated content managed directly on the filesystem.

## How it works

On startup, each directory listed in `STATIC_ROOTS` is scanned. For each file:

1. The file is stat'd and compared against the database (size + mtime). If both match, the stored CID is reused and the file is not read.
2. If the file is new or modified, it is hashed to compute its CID.

A single bundle MASL is generated for each root, with all file paths preserved relative to the root directory. `index.html` files additionally register an alias for their parent directory path. Scanning runs in the background so the server is available immediately; on a warm restart (no file changes) the indexing window is negligible.

Files are registered in SQLite with `source_path` set to their real path. They are never copied to the blob store, and they are not counted against `TOTAL_CAPACITY`. Static entries cannot be evicted by the LRU policy.

Directories configured via `MOUNT_POINTS` are automatically added to static roots — no need to list them twice. See [MOUNT_POINTS.md](MOUNT_POINTS.md) for details on mount point configuration and serving.

## Security

Only paths listed in `STATIC_ROOTS` at startup are trusted. Symlinks that resolve outside their root are skipped during indexing. At serve time, each file's `realpath` is re-verified against the configured roots, so a symlink added after startup cannot be used to escape the root.

## Versioning

Each time a root is re-indexed with changed content, a new bundle MASL is generated that links to the previous one via the `prev` field (as defined in the [MASL spec](https://dasl.ing/masl.html)). If nothing has changed, the existing MASL CID is reused. Clients holding an old MASL CID continue to work — the old MASL remains in the blob store as a pinned entry. Only the new MASL CID is needed to reach any updated files.

`STATIC_MAX_HISTORY` limits how many MASL versions stay pinned per root. Once the limit is exceeded, the oldest entry is unpinned and becomes eligible for LRU eviction. The `prev` chain remains intact in the MASL documents themselves, so an operator can traverse it and use `DELETE /content/:cid` to reclaim space sooner if needed.

## Content types

MIME types are inferred from file extensions. Supported types include `text/html`, `text/css`, `application/javascript`, `application/json`, common image and font formats, `video/mp4`, `video/webm`, and `application/pdf`. Unknown extensions are served as `application/octet-stream`.
