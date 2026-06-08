# Static roots

Static roots let you serve files from existing directories without uploading them or copying bytes into the blob store. This is useful for large files or frequently-updated content managed directly on the filesystem.

## Configuration

Static roots are configured in `rasler.config.json`. Each entry in `staticRoots` may be a plain path string or an object with additional options:

```json
{
  "staticRoots": [
    "./public",
    {
      "path": "/var/www/html",
      "watch": true,
      "ignore": ["**/*.log", ".DS_Store", "node_modules/**"]
    }
  ]
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | string | — | Directory path (required for object form; resolved relative to CWD) |
| `watch` | boolean | `false` | Re-index the root automatically when files change |
| `ignore` | string[] | `[]` | Glob patterns for files to skip during indexing |
| `generateMasl` | boolean | `true` | Whether to build a bundle MASL for the root. Set to `false` to index files as plain blobs (accessible by CID) without a MASL document. |

Directories listed in `mountPoints` are automatically included as static roots — no need to list them twice.

## How it works

On startup, each configured root is scanned. For each file:

1. The file is stat'd and compared against the database (size + mtime). If both match, the stored CID is reused and the file is not read.
2. If the file is new or modified, it is hashed to compute its CID.
3. Files matching any `ignore` pattern (relative to the root) are skipped entirely.

When `generateMasl` is `true` (the default), a single bundle MASL is generated for the root, with all file paths preserved relative to the root directory. `index.html` files additionally register an alias for their parent directory path. When `generateMasl` is `false`, files are still hashed and stored as individual blobs accessible by CID, but no MASL document is created — useful when you want a set of blobs available for direct CID retrieval without path-based resolution. Directories used as mount points always generate a MASL regardless of this setting. Scanning runs in the background so the server is available immediately; on a warm restart (no file changes) the indexing window is negligible.

Files are registered in SQLite with `source_path` set to their real path. They are never copied to the blob store, and they are not counted against `TOTAL_CAPACITY`. Static entries cannot be evicted by the LRU policy.

## Retrieving the MASL CID

Once a root has been indexed, its current bundle MASL CID is available from the operator API:

```
GET /static-roots
```

The response lists each configured root with its `maslCid`. Use that CID to build RASL paths (`/.well-known/rasl/<maslCid>/path/to/file`) or to wire a mount point via `PUT /mount-points/:hostname`.

## File watching

When `watch: true` is set for a root, RASLer starts a recursive filesystem watcher after the initial index completes. Any change inside the directory triggers a re-index after a 300 ms debounce, updating the bundle MASL and making new content immediately available.

The implicit `./public` mount (see below) does not watch by default. To enable watching for it, add it to `staticRoots` explicitly:

```json
{ "staticRoots": [{ "path": "./public", "watch": true }] }
```

## Implicit `./public` root

If a `./public` directory exists in the working directory and no root-level mount point is explicitly configured for the origin domain, RASLer automatically:

1. Adds `./public` to the static roots.
2. Serves its contents at the origin's document root (e.g. `https://example.com/`) with `Link: rel="duplicate"` headers pointing to the RASL path.

This mirrors the convention used by many web frameworks: drop files in `./public` and they are served at `/`.

## Security

Only paths configured as static roots at startup are trusted. Symlinks that resolve outside their root are skipped during indexing. At serve time, each file's `realpath` is re-verified against the configured roots, so a symlink added after startup cannot be used to escape the root.

## Versioning

Each time a root is re-indexed with changed content, a new bundle MASL is generated that links to the previous one via the `prev` field (as defined in the [MASL spec](https://dasl.ing/masl.html)). If nothing has changed, the existing MASL CID is reused. Clients holding an old MASL CID continue to work — the old MASL remains in the blob store as a pinned entry. Only the new MASL CID is needed to reach any updated files.

`staticMaxHistory` (in `rasler.config.json`) limits how many MASL versions stay pinned per root. Once the limit is exceeded, the oldest entry is unpinned and becomes eligible for LRU eviction. The `prev` chain remains intact in the MASL documents themselves, so an operator can traverse it and use `DELETE /content/:cid` to reclaim space sooner if needed.

## Content types

MIME types are inferred from file extensions. Supported types include `text/html`, `text/css`, `application/javascript`, `application/json`, common image and font formats, `video/mp4`, `video/webm`, and `application/pdf`. Unknown extensions are served as `application/octet-stream`.
