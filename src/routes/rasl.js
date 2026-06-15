import { Router } from 'express';
import { resolveRaslRequest } from '../handlers/rasl.js';

function getPathAfterCid(req, cid) {
  const cidPrefix = '/.well-known/rasl/' + cid;
  return req.path.startsWith(cidPrefix) ? req.path.slice(cidPrefix.length) : '';
}

export function makeRaslRouter({ store }) {
  const router = Router();

  async function handle(req, res, next) {
    const { cid } = req.params;
    const pathSuffix = getPathAfterCid(req, cid);
    const result = await resolveRaslRequest(store, cid, pathSuffix);

    if (result === null) return next();

    if (result.stream) {
      res.set(result.headers);
      res.set('content-length', String(result.size));
      res.status(result.status);
      return result.stream.pipe(res);
    }

    if (result.bytes) {
      res.set(result.headers);
      return res.status(result.status).send(result.bytes);
    }

    return res.status(result.status).json(result.body);
  }

  router.get('/.well-known/rasl/:cid', handle);
  router.get('/.well-known/rasl/:cid/*path', handle);
  router.head('/.well-known/rasl/:cid', handle);
  router.head('/.well-known/rasl/:cid/*path', handle);

  return router;
}

export function makeRaslNotFoundHandler() {
  const router = Router();
  const notFound = (req, res) => res.status(404).json({ error: 'Not found' });
  router.get('/.well-known/rasl/:cid', notFound);
  router.get('/.well-known/rasl/:cid/*path', notFound);
  router.head('/.well-known/rasl/:cid', notFound);
  router.head('/.well-known/rasl/:cid/*path', notFound);
  return router;
}
