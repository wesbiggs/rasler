# RASLer

RASLer is a HTTP server that implements [RASL](https://dasl.ing/rasl.html)'s `/.well-known/rasl/` endpoint, backed by content-addressed storage, [MASL](https://dasl.ing/masl.html) metadata support, and a full-featured operator API.

## Features

- **Storage** — content blobs are stored by CID on disk, backed by a SQLite database that enables capacity management and a pluggable eviction policy
- **DASL & MASL CIDs** — content serving by simple DASL CIDs, or via MASL CIDs with path-based resolution for both single files and website bundles as per the proposed specification (see ["RASL Path Resolution via MASL"](RASL_MASL_PROPOSAL.md))
- **Static roots** — serve files from local directories by CID without copying them into the blob store
- **Operator API** — upload raw files or CARs, pin/unpin, and evict; manage mount points; status, etc.
- **Server factory** — compose your own server including RASL functionality

## Quick start

```bash
npm install
cp .env.example .env
# edit .env and set ORIGIN, API_SECRET, and SWAGGER_UI=true
npm start
# open http://localhost:3000/api-docs in a browser
```

From the API docs UI, you can:
- Enter the API_SECRET to authenticate
- Upload one or more files (or CARs with MASL metadata, see [Scripts] for help building) and see their MASL CIDs

Once uploaded, you can access the files at `http://localhost:3000/.well-known/rasl/<cid>`.

## Slow start

See [USE_CASES.md](USE_CASES.md) for an overview of common deployment patterns including virtual hosting and static roots.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORIGIN` | Yes | — | This node's public origin, protocol included (e.g. `https://node1.example.com` or `http://localhost:3000`). Used in `Link: rel="duplicate"` headers. A bare hostname without protocol is accepted and defaults to `https://`. |
| `API_SECRET` | Yes | — | Pre-shared secret to send as `x-rasl-operator-secret` header |
| `PORT` | No | `3000` | HTTP listen port |
| `DATA_DIR` | No | `./data` | Directory for the SQLite database and content blobs |
| `TOTAL_CAPACITY` | No | `1G` | Storage budget (`200M`, `1G`, `2GB`, plain bytes) |
| `OPERATOR_API_PATH_PREFIX` | No | — | Mount operator API under a path prefix (e.g. `/admin`) |
| `OPERATOR_CORS_ORIGINS` | No | — | Comma-separated origins allowed cross-origin |
| `SWAGGER_UI` | No | `false` | Set `true` to enable interactive API docs at `<operator-api-path-prefix>/api-docs` |
| `STATIC_ROOTS` | No | — | Comma-separated directory paths to serve as static RASL roots (see [STATIC_ROOTS.md](STATIC_ROOTS.md)) |
| `STATIC_MAX_HISTORY` | No | — | Maximum pinned MASL versions per static root; older versions are unpinned for LRU eviction |
| `MOUNT_POINTS` | No | — | Comma-separated mount point definitions mapping `hostname[/prefix]:directory` (see [MOUNT_POINTS.md](MOUNT_POINTS.md)) |

## Static roots

See [STATIC_ROOTS.md](STATIC_ROOTS.md).

## Mount points

See [MOUNT_POINTS.md](MOUNT_POINTS.md).

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
  origin: 'https://mynode.example.com',
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
app.use(makeOperatorRouter({ store, selfOrigin: config.origin, apiSecret: config.apiSecret }));
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
app.use(makeRaslNotFoundHandler());
app.use(makeOperatorRouter({ store, selfOrigin: config.origin, apiSecret: config.apiSecret }));
finalizeApp(app, config);
```

## Utilities

The following utility script is included.

```bash
# Build a CAR file (with MASL bundle header) from a static website directory tree
npm run get-in-the-car <input-dir> [output.car]
```

## Development

Contributions are welcome! Please use GitHub Issues to discuss or propose improvements or file bugs.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a code walkthrough.

Pull requests that make changes to the API should include updated JSDoc and a freshly generated `openapi.json`.

### Scripts

```bash
# Run the node
npm start

# Run tests
npm test

# Regenerate openapi.json from JSDoc in src/routes/operator.js
npm run generate:openapi
```
