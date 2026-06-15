import config from './config.js';
import { openDb } from './storage/db.js';
import { makeLocalDb } from './storage/local-db.js';
import { makeLocalBlobs } from './storage/local-blobs.js';
import { Store } from './storage/store.js';
import { createApp, finalizeApp } from './server.js';
import { makeRaslNotFoundHandler } from './routes/rasl.js';
import { makeOperatorRouter } from './routes/operator.js';
import { indexStaticRoots } from './static.js';
import { startStaticRootWatchers } from './watcher.js';

function main() {
  const rawDb = openDb(config.dataDir);
  const db = makeLocalDb(rawDb);
  const blobs = makeLocalBlobs(config.dataDir);
  const store = new Store(db, blobs, config.totalCapacity, {
    staticRoots: config.staticRoots,
  });

  if (config.staticRoots.length > 0) {
    indexStaticRoots(config.staticRoots, store, { maxHistory: config.staticMaxHistory })
      .then(() => startStaticRootWatchers(config.staticRoots, store, { maxHistory: config.staticMaxHistory }));
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
    mountPoints: config.mountPoints,
  }));

  finalizeApp(app, config);

  app.listen(config.port, () => {
    console.log(`RASL node ${config.origin} listening on port ${config.port}`);
  });
}

main();
