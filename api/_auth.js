import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// If JWT_SECRET is not configured, use a random ephemeral secret so tokens
// are at least unpredictable for this process lifetime (and warn loudly).
const JWT_SECRET = process.env.JWT_SECRET
  || (console.warn('[SECURITY] JWT_SECRET not set — using an ephemeral random secret. Tokens will be invalidated on restart.'), crypto.randomBytes(32).toString('hex'));

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'auth_required', message: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'auth_required', message: 'Invalid or expired token' });
  }
}
