# Mount points

Mount points map the HTTP `Host:` header (and an optional URL path prefix) to a bundle MASL, letting the node serve a website at a plain URL (e.g. `https://example.com/about.html`) without a reverse proxy like `nginx`.

There are two kinds of mount point, which can be used together:

- **Static** — configured via the `MOUNT_POINTS` environment variable; the directory is automatically indexed as a static root at startup.
- **Runtime** — set via the operator API (`PUT /mount-points/:hostname[/:prefix]`); can point to any bundle MASL already held by the node, with no directory required.

Runtime entries take priority over static entries when both match the same hostname and prefix.

## Static mount points

Configure via `MOUNT_POINTS`:

```
MOUNT_POINTS=example.com:/var/www/html,example.com/docs:/var/www/docs,docs.example.com:/var/www/docs
```

Each entry maps a hostname with an optional URL path prefix to a local directory. The directory is automatically added to `STATIC_ROOTS` and indexed at startup (see [STATIC_ROOTS.md](STATIC_ROOTS.md) for how indexing works). On every request the current bundle MASL for that root is read from memory, so served content updates automatically after a re-index without a server restart.

## Runtime mount points

Runtime mount points are set via the operator API and persisted in the database:

```
PUT /mount-points/:hostname[/:prefix]
Body: { "maslCid": "<bundle-masl-cid>" }
```

The target MASL CID must already be held locally (e.g. uploaded via `/upload` or pinned via `/pin`) and must be a bundle MASL. The mapping is stored in SQLite and survives restarts. Use `DELETE /mount-points/:hostname[/:prefix]` to remove it.

This approach works well when you want to serve content uploaded as a CAR file, or when you want to atomically switch the content served at a hostname by pointing it at a different MASL CID.

## Request flow

The same pipeline handles both kinds of mount point:

1. The `Host:` header is matched against configured hostnames; the URL path prefix is matched to select the most specific (longest) mount point.
2. Runtime entries are checked first; static entries are the fallback.
3. The path prefix is stripped and the remaining path is resolved against the current bundle MASL for that entry.
4. Bytes are streamed to the client (static-root content directly from disk; uploaded content from the blob store).
5. `/.well-known/rasl/...` paths always pass through to the RASL router unchanged.
6. If a static mount point's root has not yet been indexed (startup window), the server returns `503`.
