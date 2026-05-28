import swaggerJsdoc from 'swagger-jsdoc';
import { writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OPERATOR_SECRET_HEADER } from '../src/middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'RASL Node Operator API',
      version: pkg.version,
      description:
        'HTTP API for managing a RASL node: uploading and pinning content, ' +
        'inspecting storage, and monitoring node status. All endpoints require the ' +
        `\`${OPERATOR_SECRET_HEADER}\` header.`,
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local node' }],
    components: {
      securitySchemes: {
        operatorSecret: {
          type: 'apiKey',
          in: 'header',
          name: OPERATOR_SECRET_HEADER,
          description: 'Pre-shared operator secret (API_SECRET env var)',
        },
      },
    },
    security: [{ operatorSecret: [] }],
    tags: [
      { name: 'Content', description: 'Upload, pin, and manage locally held content' },
      { name: 'Node',    description: 'Node status' },
    ],
  },
  apis: [resolve(__dirname, '../src/routes/operator.js')],
};

const spec = swaggerJsdoc(options);
const outPath = resolve(__dirname, '../openapi.json');
writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
console.log(`openapi.json written to ${outPath}`);
