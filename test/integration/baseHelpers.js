import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb } from '../../src/storage/db.js';
import { makeLocalDb } from '../../src/storage/local-db.js';
import { makeLocalBlobs } from '../../src/storage/local-blobs.js';
import { Store } from '../../src/storage/store.js';
import { createApp, finalizeApp } from '../../src/server.js';
import { makeRaslNotFoundHandler } from '../../src/routes/rasl.js';
import { makeOperatorRouter } from '../../src/routes/operator.js';

export function makeBaseTestApp({
  origin = 'http://test.example.com',
  apiSecret = 'test-secret',
  totalCapacity = 10 * 1024 * 1024,
  operatorCorsOrigins = [],
  operatorApiPathPrefix = '',
  staticRoots = [],
  mountPoints = [],
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'base-int-'));
  const db = makeLocalDb(openDb(dataDir));
  const blobs = makeLocalBlobs(dataDir);
  const store = new Store(db, blobs, totalCapacity, { staticRoots });

  const config = {
    origin, domain: new URL(origin).host, port: 0, apiSecret, totalCapacity, dataDir,
    operatorCorsOrigins, operatorApiPathPrefix,
    swaggerUi: false,
    mountPoints,
  };

  const app = createApp({ store, config });
  const prefix = operatorApiPathPrefix || '/';

  app.use(makeRaslNotFoundHandler());
  app.use(prefix, makeOperatorRouter({ store, selfOrigin: origin, apiSecret, corsOrigins: operatorCorsOrigins, staticRoots, mountPoints }));

  finalizeApp(app, config);

  function cleanup() {
    rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, store, cleanup, origin, apiSecret };
}
