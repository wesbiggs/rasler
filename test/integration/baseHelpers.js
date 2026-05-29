import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb } from '../../src/storage/db.js';
import { Store } from '../../src/storage/store.js';
import { createApp, finalizeApp } from '../../src/server.js';
import { makeRaslNotFoundHandler } from '../../src/routes/rasl.js';
import { makeOperatorRouter } from '../../src/routes/operator.js';

export function makeBaseTestApp({
  domain = 'test.example.com',
  apiSecret = 'test-secret',
  totalCapacity = 10 * 1024 * 1024,
  operatorCorsOrigins = [],
  operatorApiPathPrefix = '',
  staticRoots = [],
  mountPoints = [],
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'base-int-'));
  const db = openDb(dataDir);
  const store = new Store(db, dataDir, totalCapacity, { staticRoots });

  const config = {
    domain, port: 0, apiSecret, totalCapacity, dataDir,
    operatorCorsOrigins, operatorApiPathPrefix,
    swaggerUi: false,
    mountPoints,
  };

  const app = createApp({ store, config });
  const prefix = operatorApiPathPrefix || '/';

  app.use(makeRaslNotFoundHandler());
  app.use(prefix, makeOperatorRouter({ store, selfDomain: domain, apiSecret, corsOrigins: operatorCorsOrigins, staticRoots, mountPoints }));

  finalizeApp(app, config);

  function cleanup() {
    rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, store, cleanup, domain, apiSecret };
}
