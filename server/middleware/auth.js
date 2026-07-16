const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET_KEY;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET_KEY must be set in the server .env file');
}

function authenticateToken(token) {
  if (!token) throw new Error('Authentication token is required');
  return jwt.verify(token, JWT_SECRET);
}

function auth(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  try {
    req.user = authenticateToken(token);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired authentication token' });
  }
}

module.exports = { auth, authenticateToken, JWT_SECRET };
