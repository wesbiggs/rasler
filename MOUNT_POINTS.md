# Mount points

Mount points map the HTTP `Host:` header (and an optional URL path prefix) to a static root directory, letting the node serve a website at a plain URL (e.g. `https://example.com/about.html`) without a reverse proxy like `nginx`.

## Configuration

```
MOUNT_POINTS=example.com:/var/www/html,example.com/docs:/var/www/docs,docs.example.com:/var/www/docs
```

Each entry maps a hostname with an optional URL path prefix to a directory. The directory is automatically added to `STATIC_ROOTS` — no need to list it twice. More specific (longer) prefixes take priority. On every request the current bundle MASL for that root is read from memory, so the served content updates automatically after a re-index without a server restart.

## Request flow

1. The `Host:` header is matched against configured hostnames; the URL path prefix is matched to select the most specific mount point.
2. The path prefix is stripped and the remaining path is resolved against the current bundle MASL for that root.
3. Bytes are streamed directly from disk (the same static-root pipeline).
4. `/.well-known/rasl/...` paths always pass through to the RASL router unchanged.
5. If the root has not yet been indexed (startup window), the server returns `503`.
