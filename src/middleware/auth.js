export const OPERATOR_SECRET_HEADER = 'x-rasl-operator-secret';

export function requireApiSecret(apiSecret) {
  return (req, res, next) => {
    const provided = req.headers[OPERATOR_SECRET_HEADER];
    if (!provided || provided !== apiSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}
