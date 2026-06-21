# Architecture

## Overview

RASLer is an Express 5 HTTP server that implements the [RASL](https://dasl.ing/rasl.html) content-retrieval protocol on top of content-addressed storage. Content is identified by [CID](https://dasl.ing/cid.html) (content identifier) and optionally described by [MASL](https://dasl.ing/masl.html) metadata documents. The server has two distinct surfaces:

- **RASL retrieval** (`/.well-known/rasl/…`) — public, unauthenticated, CID-addressed
- **Operator API** (`/upload`, `/pin`, `/mount-points`, `/status`, …) — authenticated via a pre-shared secret

## Source layout

```
src/
  index.js              Entry point: reads config, wires components, starts listening
  config.js             Loads .env and rasler.config.json; exports frozen config object
  server.js             Express app factory (createApp / addRaslerMiddleware / finalizeApp)
  static.js             Static-root indexing: walks directories, computes CIDs, builds bundle MASLs
  watcher.js            Filesystem watchers for static roots with watch: true

  routes/
    rasl.js             RASL retrieval router (GET/HEAD /.well-known/rasl/:cid[/*path])
    mountPoints.js      Mount-point router: maps Host: header + path prefix to a bundle MASL
    operator.js         Operator API router: upload, pin, content management, mount points, status

  handlers/
    operator.js         Pure async handler functions for operator API routes
    rasl.js             Pure async handler functions for RASL retrieval routes

  storage/
    store.js            Store class: unified content access layer
    db.js               SQLite helpers (node:sqlite, no ORM)
    files.js            Blob filesystem helpers (sharded directory layout)
    local-db.js         LocalDb adapter: wraps db.js functions into the interface expected by Store
    local-blobs.js      LocalBlobs adapter: wraps files.js functions into the interface expected by Store

  masl/
    document.js         MASL encode/decode, path resolution, link extraction

  crypto/
    cid.js              CID computation (SHA-256 / raw or dag-cbor), Unencoded-Digest formatting

  middleware/
    auth.js             requireApiSecret middleware
    cors.js             Operator CORS middleware

  util/
    env.js              required() / optional() env var helpers; loads .env file
    loadRaslerConfig.js Reads rasler.config.json from CWD; returns parsed object or null
    parseJsonConfig.js  Pure functions: parseJsonStaticRoots(), parseJsonMountPoints()
    normalizeMountPath.js  Normalises URL path prefixes (strips trailing slash, adds leading /)
    parseSize.js        Human-readable byte sizes (1G, 200M, …) → integer
    mime.js             Extension → MIME type lookup

scripts/
  generate-openapi.js   Generates openapi.json from @openapi JSDoc in operator.js
  get-in-the-car.js     CLI: builds a DASL-compliant CAR file from a local directory

test/
  unit/                 Pure-function tests (CID, MASL, Store, config parsing)
  integration/          Full HTTP tests via supertest
    baseHelpers.js      makeBaseTestApp() — shared test app factory
```

## Request flow

Three Express routers are stacked in order. A request falls through to the next router if the current one does not match:

```
Incoming request
       │
       ▼
┌─────────────────────┐
│  Mount-point router │  GET/HEAD only. Matches Host: header + path prefix against
│  (mountPoints.js)   │  configured mount points. Resolves path against bundle MASL,
│                     │  streams file from disk. Sets Link: rel="duplicate" header.
│                     │  Passes /.well-known/rasl/ paths through unchanged.
└────────┬────────────┘
         │ no match
         ▼
┌─────────────────────┐
│   RASL router       │  GET/HEAD /.well-known/rasl/:cid[/*path].
│   (rasl.js)         │  Path-free: raw bytes. Path-bearing: MASL path resolution.
│                     │  On local miss, calls next() (for overlay / federation).
└────────┬────────────┘
         │ no match
         ▼
┌─────────────────────┐
│  RASL 404 handler   │  Terminates any remaining /.well-known/rasl/ request with 404.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Operator router    │  All other paths. Requires x-rasl-operator-secret header.
│  (operator.js)      │  Body parsing (JSON / multipart) is scoped here only.
└─────────────────────┘
```

## Storage layer

### Store (`store.js`)

`Store` is the single access point for all content operations. It bridges two backends:

- **SQLite** (`db.js`) — tracks metadata: CID, size, pin status, last-requested timestamp, and optionally `source_path` / `source_mtime` for static content
- **Blob files** (`files.js`) — stores uploaded content bytes in a sharded directory: `data/blobs/<shard>/<cid>`, where `<shard>` is characters `[-3:-1]` of the CID string (avoids the constant `ba` prefix of CIDv1 base32)

Static-root content is never copied into the blob store. The DB row carries `source_path` (the real filesystem path) and `pinned = 2` (a sentinel that excludes the entry from pool capacity accounting and LRU eviction). At serve time, `getContentStream()` re-resolves the real path and verifies it still falls under a configured static root before opening the file.

### Pinning and eviction

Content has three pin states stored in `content.pinned`:

| Value | Meaning |
|---|---|
| `0` | Unpinned — eligible for LRU eviction |
| `1` | Pinned — held indefinitely, counts against pinned capacity |
| `2` | Static — filesystem-backed, never evicted, not counted against any capacity limit |

`evictIfNeeded(requiredBytes)` is called before each upload. The eviction policy is embedded in the db adapter's `findEvictionCandidate` method (the local adapter picks the oldest unpinned entry by `last_requested`). Providing a custom db adapter allows a different eviction strategy — useful for multi-node deployments.

### SQLite schema

```sql
content (
  cid TEXT PRIMARY KEY,
  masl_cid TEXT,          -- owning MASL document, if any
  size INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  last_requested INTEGER, -- Unix ms; updated on every retrieval
  source_path TEXT,       -- static entries only
  source_mtime INTEGER    -- used for change detection on re-index
)

mount_points (
  hostname TEXT NOT NULL,   -- '' = wildcard (matches any Host: header)
  mount_path TEXT NOT NULL DEFAULT '',  -- normalised prefix, '' = root
  masl_cid TEXT NOT NULL,
  PRIMARY KEY (hostname, mount_path)
)
```

## CIDs and MASL

All CIDs are CIDv1 encoded in base32 lowercase (`bafy…` for dag-cbor, `bafk…` for raw).

- **Data CID** — `sha2-256` of raw bytes, codec `raw` (0x55)
- **MASL CID** — `sha2-256` of dag-cbor–encoded document, codec `dag-cbor` (0x71)

MASL documents come in two forms:

- **Single** — wraps one file: `{ name, src: {$link: dataCid}, content-type, content-length, … }`
- **Bundle** — wraps a directory tree: `{ name, resources: { "/path": { src, content-type, … }, … }, prev? }`

The `prev` field links to the previous bundle MASL, forming a hash chain. On re-index, if no files changed the existing MASL CID is reused; a new one is only generated when content actually changes.

## Static roots and mount points

**Static roots** are local directories indexed at startup by `indexStaticRoot()` in `static.js`. Each file is stat'd and compared against the DB (size + mtime). On a cache hit the stored CID is reused; on a miss the file is hashed. A bundle MASL is built for the root and stored pinned. The `staticRootMasls` map in `Store` (realpath → maslCid) is updated in memory so the mount-point router always reads the latest version without a DB query.

**Mount points** map an optional `Host:` header value (plus an optional URL path prefix) to a bundle MASL. A mount point with no hostname (stored as `''`) is a wildcard that matches any `Host:` value. Two sources, priority order:

1. **Runtime** — set via `PUT /mount-points/:hostname[/:prefix]`, persisted in the `mount_points` SQLite table, loaded into `store.runtimeMountPoints` on startup and kept in sync in memory.
2. **Static** — derived from `MOUNT_POINTS` env config; the directory is automatically added to static roots.

Entries are sorted longest-prefix-first; at equal prefix length, specific-hostname entries are checked before wildcard (`hostname=''`) entries. The mount-point router checks runtime entries first, then static.

## Configuration

`config.js` reads environment variables through `util/env.js` (which also loads `.env`) and reads `rasler.config.json` from CWD via `util/loadRaslerConfig.js`. Complex JSON fields are parsed by pure functions in `util/parseJsonConfig.js` so they can be unit-tested independently of the module-load-time side effects in `config.js`.

Key config fields:

| Field | Source | Notes |
|---|---|---|
| `origin` | `ORIGIN` env var | Full origin URL (protocol + host); used in `Link:` headers |
| `domain` | — | Derived from `origin` (host portion only) |
| `mountPoints` | `rasler.config.json` | Parsed array of `{hostname, prefix, directory}` |
| `staticRoots` | `rasler.config.json` | Deduplicated union of explicit roots, mount point dirs, and implicit `./public`. Each entry is `{directory, watch, ignore}`. |
| `staticMaxHistory` | `rasler.config.json` | Max pinned MASL versions per root; `null` means unlimited |

## Library usage

`server.js` exports two factories:

- **`createApp({ store, config, openApiOverlays? })`** — creates a new Express app with `trust proxy: 1` and mounts all RASLer middleware. For standalone deployments.
- **`addRaslerMiddleware(app, { store, config, openApiOverlays? })`** — mounts RASLer onto an existing Express app without touching `trust proxy`. For embedding RASLer into a larger service.

`openApiOverlays` is an optional array of file paths to OpenAPI overlay JSON specs that are merged into the base `openapi.json` before Swagger UI is set up. Useful for adding custom endpoints to the API docs.

Both expect the caller to add `makeRaslNotFoundHandler()`, mount the operator router, and call `finalizeApp()`.

The operator router (`makeOperatorRouter`) and RASL router (`makeRaslRouter`) are also exported individually for fine-grained composition. `makeOperatorRouter` accepts `{ store, selfOrigin, apiSecret, corsOrigins?, staticRoots?, mountPoints? }`. The `/status` endpoint uses a two-part design: `makeOperatorRouter` writes base fields to `res.locals.status` and calls `next()`; `makeOperatorStatusTerminator` (or an overlay router) sends the final response. This lets an embedding application add extra fields to `/status` without forking the base router.

### Standalone

```js
import { openDb } from 'rasler/src/storage/db.js';
import { makeLocalDb } from 'rasler/src/storage/local-db.js';
import { makeLocalBlobs } from 'rasler/src/storage/local-blobs.js';
import { Store } from 'rasler/src/storage/store.js';
import { createApp, finalizeApp } from 'rasler/src/server.js';
import { makeRaslNotFoundHandler } from 'rasler/src/routes/rasl.js';
import { makeOperatorRouter } from 'rasler/src/routes/operator.js';
import { indexStaticRoots } from 'rasler/src/static.js';

const staticRoots = [{ directory: '/var/www/html', watch: false, ignore: [] }];

const rawDb = openDb('./data');
const db = makeLocalDb(rawDb);
const blobs = makeLocalBlobs('./data');
const store = new Store(db, blobs, 1024 * 1024 * 1024, { staticRoots });

const config = {
  origin: 'https://mynode.example.com',
  port: 3000,
  apiSecret: process.env.API_SECRET,
  totalCapacity: 1024 * 1024 * 1024,
  dataDir: './data',
  operatorCorsOrigins: [],
  operatorApiPathPrefix: '',
  swaggerUi: false,
  staticRoots,
  staticMaxHistory: 3,
};

if (config.staticRoots.length > 0) {
  await indexStaticRoots(config.staticRoots, store, { maxHistory: config.staticMaxHistory });
}

const app = createApp({ store, config });
const prefix = config.operatorApiPathPrefix || '/';

app.use(makeRaslNotFoundHandler());
app.use(prefix, makeOperatorRouter({
  store,
  selfOrigin: config.origin,
  apiSecret: config.apiSecret,
  corsOrigins: config.operatorCorsOrigins,
  staticRoots: config.staticRoots,
  mountPoints: [],
}));
finalizeApp(app, config);

app.listen(config.port);
```

### Adding to an existing Express 5 app

Use `addRaslerMiddleware` instead of `createApp` to mount RASLer onto an app you already control. `trust proxy` is not set — configure it on your app as needed.

```js
import { addRaslerMiddleware, finalizeApp } from 'rasler/src/server.js';
import { makeRaslNotFoundHandler } from 'rasler/src/routes/rasl.js';
import { makeOperatorRouter } from 'rasler/src/routes/operator.js';

// your existing app
addRaslerMiddleware(app, { store, config });
const prefix = config.operatorApiPathPrefix || '/';
app.use(makeRaslNotFoundHandler());
app.use(prefix, makeOperatorRouter({
  store,
  selfOrigin: config.origin,
  apiSecret: config.apiSecret,
  corsOrigins: config.operatorCorsOrigins ?? [],
  staticRoots: config.staticRoots ?? [],
  mountPoints: config.mountPoints ?? [],
}));
finalizeApp(app, config);
```

## OpenAPI

`openapi.json` is generated from `@openapi` JSDoc blocks in `src/routes/operator.js` by running `npm run generate:openapi` (via `scripts/generate-openapi.js` using `swagger-jsdoc`). The file is committed and served via Swagger UI when `SWAGGER_UI=true`.
