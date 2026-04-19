'use strict';

const crypto = require('crypto');
const config = require('./config');

function getClientIp(req) {
  const cfIp = req.headers?.['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function maskToken(token) {
  const value = String(token || '').trim();
  if (!value) return '(empty)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)} (len=${value.length})`;
}

function getRequestToken(req) {
  const headerToken = req.headers?.['x-access-token'];
  if (Array.isArray(headerToken) && headerToken[0]) {
    return String(headerToken[0]).trim();
  }
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  if (req.query?.token) return String(req.query.token).trim();
  if (req.body?.token) return String(req.body.token).trim();

  try {
    const rawUrl = req.url || '';
    const params = new URL(rawUrl, 'http://localhost').searchParams;
    const urlToken = params.get('token');
    if (urlToken) return String(urlToken).trim();
  } catch {
    // ignore malformed URLs
  }

  return '';
}

function isValidToken(token) {
  const expected = String(config.accessToken || '').trim();
  if (!expected) {
    console.warn('[Auth] TOKENACCESS is empty. Authentication is bypassed until configured.');
    return true;
  }
  return safeEqual(String(token).trim(), expected);
}

function requireAuth(req, res, next) {
  const token = getRequestToken(req);
  const ip = getClientIp(req);
  const target = `${req.method} ${req.originalUrl}`;

  if (!token) {
    console.warn(`[Auth] Missing token | ip=${ip} | ${target}`);
    return res.status(401).json({ error: 'Access token required' });
  }

  if (!isValidToken(token)) {
    console.warn(`[Auth] Invalid token | ip=${ip} | ${target} | provided=${maskToken(token)} | expected=${maskToken(config.accessToken)}`);
    return res.status(403).json({ error: 'Invalid access token' });
  }

  console.log(`[Auth] Access granted | ip=${ip} | ${target}`);
  req.clientIp = ip;
  next();
}

module.exports = {
  getClientIp,
  getRequestToken,
  isValidToken,
  requireAuth,
};
