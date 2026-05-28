import config from './config.js';
import { openDb } from './storage/db.js';
import { Store } from './storage/store.js';
import { createApp, finalizeApp } from './server.js';
import { makeRaslNotFoundHandler } from './routes/rasl.js';
import { makeOperatorRouter } from './routes/operator.js';
import { indexStaticRoots } from './static.js';

function main() {
  const db = openDb(config.dataDir);
  const store = new Store(db, config.dataDir, config.totalCapacity, {
    staticRoots: config.staticRoots,
  });

  // Index static roots in the background so the server starts immediately.
  // On first startup, static CIDs won't be available until indexing finishes.
  // On subsequent startups the mtime cache makes indexing fast enough that
  // the window is negligible.
  if (config.staticRoots.length > 0) {
    indexStaticRoots(config.staticRoots, store, { maxHistory: config.staticMaxHistory });
  }

  const app = createApp({ store, config });
  const prefix = config.operatorApiPathPrefix || '/';

  app.use(makeRaslNotFoundHandler());
  app.use(prefix, makeOperatorRouter({
    store,
    selfDomain: config.domain,
    apiSecret: config.apiSecret,
    corsOrigins: config.operatorCorsOrigins,
    staticRoots: config.staticRoots,
    virtualHosts: config.virtualHosts,
  }));

  finalizeApp(app, config);

  app.listen(config.port, () => {
    console.log(`RASL node ${config.domain} listening on port ${config.port}`);
  });
}

main();
