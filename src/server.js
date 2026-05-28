import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { makeRaslRouter } from './routes/rasl.js';
import { makeOperatorStatusTerminator } from './routes/operator.js';
import { makeVirtualHostRouter } from './routes/vhost.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function mergeSpecs(base, overlay) {
  return {
    ...base,
    ...overlay,
    info: { ...base.info, ...overlay.info },
    components: {
      ...base.components,
      ...overlay.components,
      schemas: {
        ...(base.components?.schemas ?? {}),
        ...(overlay.components?.schemas ?? {}),
      },
      securitySchemes: {
        ...(base.components?.securitySchemes ?? {}),
        ...(overlay.components?.securitySchemes ?? {}),
      },
    },
    tags: [
      ...(base.tags ?? []),
      ...(overlay.tags ?? []).filter(t => !(base.tags ?? []).some(bt => bt.name === t.name)),
    ],
    paths: { ...(base.paths ?? {}), ...(overlay.paths ?? {}) },
  };
}

// Base app factory: express setup, static files, base RASL content router,
// and Swagger UI (if configured). Does not mount the operator router or any
// overlay — callers do that before calling finalizeApp().
// openApiOverlays: array of file paths to OpenAPI overlay specs to merge in.
export function createApp({ store, config, openApiOverlays = [] }) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(resolve(__dirname, '..', 'public')));

  app.use(makeVirtualHostRouter({ store, virtualHosts: config.virtualHosts ?? new Map() }));

  app.use(makeRaslRouter({ store }));

  // Swagger UI — mounted early so the browser can load it without credentials.
  // Use the Authorize button to set x-rasl-operator-secret.
  if (config.swaggerUi) {
    const operatorPrefix = config.operatorApiPathPrefix ?? '';
    let spec = JSON.parse(readFileSync(resolve(__dirname, '..', 'openapi.json'), 'utf8'));
    for (const overlayPath of openApiOverlays) {
      const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
      spec = mergeSpecs(spec, overlay);
    }
    spec.servers = [{ url: operatorPrefix || '/', description: 'This node' }];
    const swaggerPath = `${operatorPrefix}/api-docs`;
    app.use(swaggerPath, swaggerUi.serve, swaggerUi.setup(spec, {
      swaggerOptions: { persistAuthorization: true },
    }));
    console.log(`Swagger UI enabled at ${swaggerPath}`);
  }

  return app;
}

// Adds the RASL 404 terminator, operator /status terminator, and error
// handler. Call after all overlay middleware and the operator router have
// been mounted.
export function finalizeApp(app, config) {
  const prefix = (config.operatorApiPathPrefix ?? '') || '/';
  app.use(prefix, makeOperatorStatusTerminator());
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
}
