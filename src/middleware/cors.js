import { OPERATOR_SECRET_HEADER } from './auth.js';

// Returns Express middleware that adds CORS headers to operator API responses.
// origins: string[] — pass ['*'] to allow all, or a list of specific origins.
export function makeOperatorCors(origins) {
  const allowAll = origins.includes('*');

  return (req, res, next) => {
    const requestOrigin = req.headers.origin;

    if (!requestOrigin) return next();

    if (allowAll) {
      res.set('Access-Control-Allow-Origin', '*');
    } else if (origins.includes(requestOrigin)) {
      res.set('Access-Control-Allow-Origin', requestOrigin);
      res.vary('Origin');
    } else {
      // Origin not in whitelist — no CORS headers; browser will block the request.
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      return next();
    }

    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', `Content-Type, ${OPERATOR_SECRET_HEADER}`);

    if (req.method === 'OPTIONS') return res.sendStatus(204);

    next();
  };
}
