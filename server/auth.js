import crypto from 'node:crypto';

const COOKIE = 'ctdash_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 10;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Password login with in-memory sessions. Disabled when no password is configured. */
export function createAuth({ password }) {
  const enabled = Boolean(password);
  const expected = sha256(password);
  const sessions = new Map(); // token -> expiry timestamp
  const attempts = new Map(); // ip -> { count, since }

  function isAuthenticated(req) {
    if (!enabled) return true;
    const token = readCookie(req, COOKIE);
    const expiry = token && sessions.get(token);
    if (!expiry) return false;
    if (expiry < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function login(req, res) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const record = attempts.get(ip);
    if (record && now - record.since < LOGIN_WINDOW_MS && record.count >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!enabled || !crypto.timingSafeEqual(sha256(given), expected)) {
      const fresh = !record || now - record.since >= LOGIN_WINDOW_MS;
      attempts.set(ip, fresh ? { count: 1, since: now } : { ...record, count: record.count + 1 });
      return res.status(401).json({ error: 'Wrong password.' });
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now + SESSION_TTL_MS);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      // Lax (not Strict) so the cookie survives the redirect back from cTrader's login page.
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_TTL_MS,
    });
    res.json({ ok: true });
  }

  function logout(req, res) {
    const token = readCookie(req, COOKIE);
    if (token) sessions.delete(token);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  }

  function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'Please log in.' });
  }

  return { enabled, isAuthenticated, login, logout, requireAuth };
}

/** Rejects cross-site state-changing requests (defence in depth on top of SameSite cookies). */
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch {
    // fall through
  }
  res.status(403).json({ error: 'Cross-site request blocked.' });
}
