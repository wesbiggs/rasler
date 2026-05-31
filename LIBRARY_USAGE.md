# Usage as a library

## Standalone

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

## Adding to an existing Express 5 app

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

