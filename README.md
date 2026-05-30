# RASLer

RASLer is a HTTP server that implements [RASL](https://dasl.ing/rasl.html)'s `/.well-known/rasl/` endpoint, backed by content-addressed storage, [MASL](https://dasl.ing/masl.html) metadata support, and a full-featured operator API.

## What's included

- **Storage** — content blobs are stored by CID on disk, backed by a SQLite database that enables capacity management and a pluggable eviction policy
- **DASL & MASL CIDs** — content serving by simple DASL CIDs, or via MASL CIDs with path-based resolution for both single files and website bundles
- **Static roots** — serve files from local directories by CID without copying them into the blob store
- **Operator API** — upload raw files or CARs, pin/unpin, and evict; manage mount points; status, etc.
- **Server factory** — compose your own server including RASL functionality

## Quick start

```bash
npm install
cp .env.example .env
# edit .env and set DOMAIN, API_SECRET, and SWAGGER_UI=true
npm start
# open http://localhost:3000/api-docs in a browser
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DOMAIN` | Yes | — | This node's public domain name (e.g. `node1.example.com`) |
| `API_SECRET` | Yes | — | Pre-shared secret to send as `x-rasl-operator-secret` header |
| `PORT` | No | `3000` | HTTP listen port |
| `DATA_DIR` | No | `./data` | Directory for the SQLite database and content blobs |
| `TOTAL_CAPACITY` | No | `1G` | Storage budget (`200M`, `1G`, `2GB`, plain bytes) |
| `OPERATOR_API_PATH_PREFIX` | No | — | Mount operator API under a path prefix (e.g. `/admin`) |
| `OPERATOR_CORS_ORIGINS` | No | — | Comma-separated origins allowed cross-origin |
| `SWAGGER_UI` | No | `false` | Set `true` to enable interactive API docs at `<operator-api-path-prefix>/api-docs` |
| `STATIC_ROOTS` | No | — | Comma-separated directory paths to serve as static RASL roots (see below) |
| `STATIC_MAX_HISTORY` | No | — | Maximum pinned MASL versions per static root; older versions are unpinned for LRU eviction |
| `MOUNT_POINTS` | No | — | Comma-separated mount point definitions mapping `hostname[/prefix]:directory` (see below) |

## Static roots

Static roots let the operator serve files from existing directories without uploading them or copying bytes into the blob store. This is useful for large files or frequently-updated content managed directly on the filesystem.

### How it works

On startup, each directory listed in `STATIC_ROOTS` is scanned. For each file:

1. The file is stat'd and compared against the database (size + mtime). If both match, the stored CID is reused and the file is not read.
2. If the file is new or modified, it is hashed to compute its CID.

A single bundle MASL is generated for each root, with all file paths preserved relative to the root directory. `index.html` files additionally register an alias for their parent directory path. Scanning runs in the background so the server is available immediately; on a warm restart (no file changes) the indexing window is negligible.

Files are registered in SQLite with `source_path` set to their real path. They are never copied to the blob store, and they are not counted against `TOTAL_CAPACITY`. Static entries cannot be evicted by the LRU policy.

### Security

Only paths listed in `STATIC_ROOTS` at startup are trusted. Symlinks that resolve outside their root are skipped during indexing. At serve time, each file's `realpath` is re-verified against the configured roots, so a symlink added after startup cannot be used to escape the root.

### Versioning

Each time a root is re-indexed, a new bundle MASL is generated that links to the previous one via the `prev` field (as defined in the [MASL spec](https://dasl.ing/masl.html)). Clients holding an old MASL CID continue to work — the old MASL remains in the blob store as a pinned entry. Only the new MASL CID is needed to reach any updated files.

`STATIC_MAX_HISTORY` limits how many MASL versions stay pinned per root. Once the limit is exceeded, the oldest entry is unpinned and becomes eligible for LRU eviction. The `prev` chain remains intact in the MASL documents themselves, so an operator can traverse it and use `DELETE /content/:cid` to reclaim space sooner if needed.

### Content types

MIME types are inferred from file extensions. Supported types include `text/html`, `text/css`, `application/javascript`, `application/json`, common image and font formats, `video/mp4`, `video/webm`, and `application/pdf`. Unknown extensions are served as `application/octet-stream`.

## Mount points

Mount points map the HTTP `Host:` header (and an optional URL path prefix) to a static root directory, letting the node serve a website at a plain URL (e.g. `https://example.com/about.html`) without a reverse proxy like `nginx`.

### Configuration

```
MOUNT_POINTS=example.com:/var/www/html,example.com/docs:/var/www/docs,docs.example.com:/var/www/docs
```

Each entry maps a hostname with an optional URL path prefix to a directory. The directory is automatically added to `STATIC_ROOTS` — no need to list it twice. More specific (longer) prefixes take priority. On every request the current bundle MASL for that root is read from memory, so the served content updates automatically after a re-index without a server restart.

### Request flow

1. The `Host:` header is matched against configured hostnames; the URL path prefix is matched to select the most specific mount point.
2. The path prefix is stripped and the remaining path is resolved against the current bundle MASL for that root.
3. Bytes are streamed directly from disk (the same static-root pipeline).
4. `/.well-known/rasl/...` paths always pass through to the RASL router unchanged.
5. If the root has not yet been indexed (startup window), the server returns `503`.

## API

### RASL retrieval (public)

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/rasl/:cid` | Retrieve content by CID |
| `HEAD` | `/.well-known/rasl/:cid` | Same as GET, no body |
| `GET` | `/.well-known/rasl/:cid/*` | Path suffix resolved against MASL document at CID |
| `HEAD` | `/.well-known/rasl/:cid/*` | Same as GET, no body |

### Operator API (requires `x-rasl-operator-secret` header)

| Method | Path | Description |
|---|---|---|
| `GET` | `/status` | Show server status (including storage usage) |
| `POST` | `/upload` | Upload files (multipart or CAR) |
| `POST` | `/pin` | Pin CIDs |
| `DELETE` | `/pin/:cid` | Unpin a CID |
| `GET` | `/content` | List held content |
| `GET` | `/content/:cid` | Get content metadata |
| `DELETE` | `/content/:cid` | Evict a CID |
| `GET` | `/static-roots` | List configured static roots and their current MASL CIDs |
| `GET` | `/mount-points` | List all mount points (config and runtime) with their MASL CIDs |
| `PUT` | `/mount-points/:hostname[/:prefix]` | Map a hostname (with optional path prefix) to a held bundle MASL CID (runtime, persisted) |
| `DELETE` | `/mount-points/:hostname[/:prefix]` | Remove a runtime mount point mapping |

The Operator API can be relocated via the `OPERATOR_API_PATH_PREFIX` environment option.

### Swagger UI

If enabled with `SWAGGER_UI=true`, the operator API documentation from `openapi.json` is used to power an interactive UI.

The Swagger UI is found at `/api-docs` (with optional `OPERATOR_API_PATH_PREFIX`).

## Usage as a library

### Standalone

```js
import { openDb } from 'rasler/src/storage/db.js';
import { Store } from 'rasler/src/storage/store.js';
import { createApp, finalizeApp } from 'rasler/src/server.js';
import { makeRaslNotFoundHandler } from 'rasler/src/routes/rasl.js';
import { makeOperatorRouter } from 'rasler/src/routes/operator.js';
import { indexStaticRoots } from 'rasler/src/static.js';

const db = openDb('./data');
const store = new Store(db, './data', 1024 * 1024 * 1024, {
  staticRoots: ['/var/www/html'],
});

const config = {
  domain: 'mynode.example.com',
  port: 3000,
  apiSecret: process.env.API_SECRET,
  totalCapacity: 1024 * 1024 * 1024,
  dataDir: './data',
  operatorCorsOrigins: [],
  operatorApiPathPrefix: '',
  swaggerUi: false,
  staticRoots: ['/var/www/html'],
  staticMaxHistory: 3,
};

if (config.staticRoots.length > 0) {
  indexStaticRoots(config.staticRoots, store, { maxHistory: config.staticMaxHistory });
}

const app = createApp({ store, config });
app.use(makeRaslNotFoundHandler());
app.use(makeOperatorRouter({ store, selfDomain: config.domain, apiSecret: config.apiSecret }));
finalizeApp(app, config);

app.listen(config.port);
```

### Adding to an existing Express app

Use `addRaslerMiddleware` instead of `createApp` to mount RASLer onto an app you already control. `trust proxy` is not set — configure it on your app as needed.

```js
import { addRaslerMiddleware, finalizeApp } from 'rasler/src/server.js';
import { makeRaslNotFoundHandler } from 'rasler/src/routes/rasl.js';
import { makeOperatorRouter } from 'rasler/src/routes/operator.js';

// your existing app
addRaslerMiddleware(app, { store, config });
app.use(makeRaslNotFoundHandler());
app.use(makeOperatorRouter({ store, selfDomain: config.domain, apiSecret: config.apiSecret }));
finalizeApp(app, config);
```

## Scripts

```bash
# Run the node
npm start

# Run tests
npm test

# Regenerate openapi.json from JSDoc in src/routes/operator.js
npm run generate:openapi

# Build a CAR file (with MASL bundle header) from a static website directory tree
npm run get-in-the-car <input-dir> [output.car]
```
