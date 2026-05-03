import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.admin'), override: false });

const { closeDatabase, db, nowIso, transaction } = await import('@albums/shared/db');
const { config } = await import('@albums/shared/config');

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const reportStatuses = new Set(['open', 'reviewing', 'closed', 'spam']);
const adminSessions = new Map();
const rateLimitBuckets = new Map();
let lastRateLimitSweep = 0;

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInteger(name, value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

const adminPort = parsePositiveInteger('ADMIN_PORT', process.env.ADMIN_PORT || process.env.PORT, 3001, { min: 1, max: 65535 });
const adminHost = String(process.env.ADMIN_HOST || '127.0.0.1').trim() || '127.0.0.1';
const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
const adminPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
const adminUsername = String(process.env.ADMIN_USERNAME || 'admin').trim();
const adminOrigins = String(process.env.ADMIN_ORIGINS || process.env.ADMIN_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const adminCookieName = String(process.env.ADMIN_SESSION_COOKIE_NAME || 'albums_admin_sid').trim() || 'albums_admin_sid';
const adminSessionDays = parsePositiveInteger('ADMIN_SESSION_DAYS', process.env.ADMIN_SESSION_DAYS, 1, { min: 1, max: 7 });
const adminCookieSecure = parseBoolean(process.env.ADMIN_COOKIE_SECURE, false);
const adminSessionTtlMs = adminSessionDays * 24 * 60 * 60 * 1000;
const adminPublicDir = fileURLToPath(new URL('./public', import.meta.url));

if (!adminToken && !adminPasswordHash) {
  throw new Error('ADMIN_PASSWORD_HASH or ADMIN_TOKEN is required to start the admin server.');
}

if (!adminUsername) {
  throw new Error('ADMIN_USERNAME must not be empty.');
}

if (adminToken && Buffer.byteLength(adminToken) < 32) {
  throw new Error('ADMIN_TOKEN must be at least 32 bytes.');
}

if (adminPasswordHash) {
  let rounds = 0;
  try {
    rounds = bcrypt.getRounds(adminPasswordHash);
  } catch {
    throw new Error('ADMIN_PASSWORD_HASH must be a valid bcrypt hash.');
  }
  if (rounds < 10) {
    throw new Error('ADMIN_PASSWORD_HASH must use at least 10 bcrypt rounds.');
  }
}

function route(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        try {
          return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
        } catch {
          return [part.slice(0, index), ''];
        }
      })
  );
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function sweepRateLimits(now) {
  if (now - lastRateLimitSweep < 60_000) return;
  lastRateLimitSweep = now;
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}

function enforceRateLimit(req, scope, { limit, windowMs, key = clientIp(req), message = 'Too many requests. Try again shortly.' }) {
  const now = Date.now();
  sweepRateLimits(now);
  const bucketKey = `${scope}:${key}`;
  const current = rateLimitBuckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return;
  }

  current.count += 1;
  if (current.count > limit) {
    const error = httpError(429, message);
    error.retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    throw error;
  }
}

function requestOrigin(req) {
  const host = req.get('host') || `${adminHost}:${adminPort}`;
  return `${req.protocol}://${host}`;
}

function originAllowed(origin, req) {
  try {
    const parsedOrigin = new URL(origin).origin;
    return (
      parsedOrigin === requestOrigin(req) ||
      adminOrigins.includes(parsedOrigin) ||
      parsedOrigin === `http://127.0.0.1:${adminPort}` ||
      parsedOrigin === `http://localhost:${adminPort}`
    );
  } catch {
    return false;
  }
}

function localHostFromHeader(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? '' : host.slice(1, end);
  }
  return host.split(':')[0];
}

function requireLocalHost(req, res, next) {
  const host = localHostFromHeader(req.get('host'));
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw httpError(403, 'Admin is only available on localhost.');
  }
  next();
}

function validateRequestOrigin(req, res, next) {
  if (safeMethods.has(req.method)) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (origin) {
    if (!originAllowed(origin, req)) throw httpError(403, 'Cross-origin requests are not allowed.');
    next();
    return;
  }

  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    throw httpError(403, 'Cross-origin requests are not allowed.');
  }
  next();
}

function setNoStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function setAdminSessionCookie(res, token) {
  res.cookie(adminCookieName, token, {
    httpOnly: true,
    secure: adminCookieSecure,
    sameSite: 'strict',
    path: '/admin/api',
    maxAge: adminSessionTtlMs
  });
}

function clearAdminSessionCookie(res) {
  res.clearCookie(adminCookieName, {
    httpOnly: true,
    secure: adminCookieSecure,
    sameSite: 'strict',
    path: '/admin/api'
  });
}

function cleanupExpiredAdminSessions() {
  const now = Date.now();
  for (const [tokenHash, session] of adminSessions.entries()) {
    if (session.expiresAt <= now) adminSessions.delete(tokenHash);
  }
}

function createAdminSession(res) {
  cleanupExpiredAdminSessions();
  const token = randomToken();
  const tokenHash = hashToken(token);
  const csrfToken = randomToken();
  adminSessions.set(tokenHash, {
    csrfToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + adminSessionTtlMs,
    lastSeenAt: Date.now()
  });
  setAdminSessionCookie(res, token);
  return csrfToken;
}

function deleteAdminSession(req, res) {
  if (req.adminSessionTokenHash) adminSessions.delete(req.adminSessionTokenHash);
  clearAdminSessionCookie(res);
}

function bearerToken(req) {
  const header = String(req.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function loadAdminAuth(req, res, next) {
  req.adminAuth = null;
  req.adminSessionTokenHash = null;

  const token = bearerToken(req);
  if (adminToken && token && safeEquals(token, adminToken)) {
    req.adminAuth = { kind: 'token' };
    next();
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[adminCookieName];
  if (sessionToken) {
    const tokenHash = hashToken(sessionToken);
    const session = adminSessions.get(tokenHash);
    if (session && session.expiresAt > Date.now()) {
      session.lastSeenAt = Date.now();
      req.adminAuth = { kind: 'session', session };
      req.adminSessionTokenHash = tokenHash;
      next();
      return;
    }
    adminSessions.delete(tokenHash);
    clearAdminSessionCookie(res);
  }

  throw httpError(401, 'Admin authentication is required.');
}

function requireCsrf(req, res, next) {
  if (safeMethods.has(req.method) || req.adminAuth?.kind !== 'session') {
    next();
    return;
  }

  const csrfHeader = String(req.get('x-admin-csrf') || '');
  if (!csrfHeader || !safeEquals(csrfHeader, req.adminAuth.session.csrfToken)) {
    throw httpError(403, 'A valid CSRF token is required.');
  }
  next();
}

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function parseId(value, name = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, `${name} must be a positive integer.`);
  return id;
}

function parseBoundedInteger(value, fallback, { min = 0, max = 100 } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function count(table, where = '', ...params) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get(...params);
  return Number(row?.count || 0);
}

function safeUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    disabledAt: row.disabled_at || null,
    disabledReason: row.disabled_reason || '',
    anonymizedAt: row.anonymized_at || null,
    createdAt: row.created_at,
    activeSessionCount: Number(row.active_session_count || 0),
    listCount: Number(row.list_count || 0),
    ratingCount: Number(row.rating_count || 0),
    reportCount: Number(row.report_count || 0)
  };
}

function safeReport(row) {
  return {
    id: row.id,
    userId: row.user_id || null,
    username: row.username || null,
    email: row.email || null,
    body: row.body,
    path: row.path || '',
    status: row.status,
    createdAt: row.created_at
  };
}

function getAdminUser(userId) {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.email, u.disabled_at, u.disabled_reason, u.anonymized_at, u.created_at,
              COALESCE(s.active_session_count, 0) AS active_session_count,
              COALESCE(l.list_count, 0) AS list_count,
              COALESCE(r.rating_count, 0) AS rating_count,
              COALESCE(br.report_count, 0) AS report_count
       FROM users u
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS active_session_count
         FROM sessions
         WHERE expires_at > ?
         GROUP BY user_id
       ) s ON s.user_id = u.id
       LEFT JOIN (
         SELECT owner_user_id, COUNT(*) AS list_count
         FROM lists
         GROUP BY owner_user_id
       ) l ON l.owner_user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS rating_count
         FROM track_ratings
         GROUP BY user_id
       ) r ON r.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS report_count
         FROM bug_reports
         WHERE user_id IS NOT NULL
         GROUP BY user_id
       ) br ON br.user_id = u.id
       WHERE u.id = ?`
    )
    .get(nowIso(), userId);
  if (!row) throw httpError(404, 'User not found.');
  return safeUser(row);
}

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', false);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: false,
    referrerPolicy: { policy: 'no-referrer' }
  })
);
app.use(setNoStore);
app.use(requireLocalHost);
app.use(validateRequestOrigin);
app.use(express.json({ limit: '100kb' }));

app.get('/', (req, res) => {
  res.redirect(302, '/admin/');
});
app.use(
  '/admin',
  express.static(adminPublicDir, {
    index: 'index.html',
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
    }
  })
);

app.post(
  '/admin/api/login',
  route((req, res) => {
    if (!adminPasswordHash) throw httpError(400, 'Password login is not configured.');
    enforceRateLimit(req, 'admin-login', {
      limit: 12,
      windowMs: 10 * 60 * 1000,
      message: 'Too many admin login attempts. Try again shortly.'
    });

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !safeEquals(username, adminUsername) || !password || !bcrypt.compareSync(password, adminPasswordHash)) {
      throw httpError(401, 'Invalid admin credentials.');
    }

    const csrfToken = createAdminSession(res);
    res.json({ ok: true, csrfToken });
  })
);

app.use('/admin/api', loadAdminAuth, requireCsrf);

app.get(
  '/admin/api/health',
  route((req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: nowIso(), uptimeSeconds: Math.round(process.uptime()), database: 'ok' });
  })
);

app.post(
  '/admin/api/logout',
  route((req, res) => {
    if (req.adminAuth?.kind === 'session') deleteAdminSession(req, res);
    res.json({ ok: true });
  })
);

app.get(
  '/admin/api/me',
  route((req, res) => {
    res.json({
      authenticated: true,
      authKind: req.adminAuth.kind,
      csrfToken: req.adminAuth.kind === 'session' ? req.adminAuth.session.csrfToken : null
    });
  })
);

app.get(
  '/admin/api/summary',
  route((req, res) => {
    const activeAt = nowIso();
    const bugReportsByStatus = db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM bug_reports
         GROUP BY status
         ORDER BY status`
      )
      .all()
      .map((row) => ({ status: row.status, count: Number(row.count || 0) }));
    const recentSignups = db
      .prepare(
        `SELECT id, username, disabled_at, anonymized_at, created_at
         FROM users
         ORDER BY created_at DESC, id DESC
         LIMIT 10`
      )
      .all()
      .map((row) => ({
        id: row.id,
        username: row.username,
        disabledAt: row.disabled_at || null,
        anonymizedAt: row.anonymized_at || null,
        createdAt: row.created_at
      }));

    res.json({
      counts: {
        users: count('users'),
        disabledUsers: count('users', 'WHERE disabled_at IS NOT NULL'),
        activeSessions: count('sessions', 'WHERE expires_at > ?', activeAt),
        lists: count('lists'),
        albums: count('list_albums'),
        ratings: count('track_ratings'),
        messages: count('list_messages')
      },
      bugReportsByStatus,
      recentSignups
    });
  })
);

app.get(
  '/admin/api/users',
  route((req, res) => {
    const limit = parseBoundedInteger(req.query.limit, 50, { min: 1, max: 100 });
    const offset = parseBoundedInteger(req.query.offset, 0, { min: 0, max: 100_000 });
    const status = String(req.query.status || 'all').trim().toLowerCase();
    const q = clampText(req.query.q, 120);
    const filters = [];
    const params = [];

    if (status === 'disabled') filters.push('u.disabled_at IS NOT NULL');
    else if (status === 'active') filters.push('u.disabled_at IS NULL');
    else if (status !== 'all' && status !== '') throw httpError(400, 'status must be all, active, or disabled.');

    if (q) {
      const like = `%${escapeLike(q.toLowerCase())}%`;
      filters.push('(LOWER(u.username) LIKE ? ESCAPE ? OR LOWER(u.email) LIKE ? ESCAPE ? OR CAST(u.id AS TEXT) = ?)');
      params.push(like, '\\', like, '\\', /^\d+$/.test(q) ? q : '');
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).get(...params).count;
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.email, u.disabled_at, u.disabled_reason, u.anonymized_at, u.created_at,
                COALESCE(s.active_session_count, 0) AS active_session_count,
                COALESCE(l.list_count, 0) AS list_count,
                COALESCE(r.rating_count, 0) AS rating_count,
                COALESCE(br.report_count, 0) AS report_count
         FROM users u
         LEFT JOIN (
           SELECT user_id, COUNT(*) AS active_session_count
           FROM sessions
           WHERE expires_at > ?
           GROUP BY user_id
         ) s ON s.user_id = u.id
         LEFT JOIN (
           SELECT owner_user_id, COUNT(*) AS list_count
           FROM lists
           GROUP BY owner_user_id
         ) l ON l.owner_user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*) AS rating_count
           FROM track_ratings
           GROUP BY user_id
         ) r ON r.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*) AS report_count
           FROM bug_reports
           WHERE user_id IS NOT NULL
           GROUP BY user_id
         ) br ON br.user_id = u.id
         ${where}
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(nowIso(), ...params, limit, offset)
      .map(safeUser);

    res.json({ users: rows, total: Number(total || 0), limit, offset });
  })
);

app.post(
  '/admin/api/users/:id/disable',
  route((req, res) => {
    const userId = parseId(req.params.id, 'User id');
    const reason = clampText(req.body?.reason, 500);
    if (!reason) throw httpError(400, 'A disable reason is required.');
    const updated = transaction(() => {
      const user = db.prepare('SELECT id, username, disabled_at, disabled_reason FROM users WHERE id = ?').get(userId);
      if (!user) throw httpError(404, 'User not found.');

      const disabledAt = user.disabled_at || nowIso();
      db.prepare('UPDATE users SET disabled_at = ?, disabled_reason = ? WHERE id = ?').run(disabledAt, reason, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare(
        `INSERT INTO admin_action_log (action, user_id, previous_username, new_username, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'disable',
        user.id,
        user.username,
        user.username,
        JSON.stringify({ reason, previousDisabledAt: user.disabled_at || null, previousReason: user.disabled_reason || '' }),
        nowIso()
      );
      return getAdminUser(user.id);
    })();

    res.json({ user: updated });
  })
);

app.post(
  '/admin/api/users/:id/enable',
  route((req, res) => {
    const userId = parseId(req.params.id, 'User id');
    const updated = transaction(() => {
      const user = db.prepare('SELECT id, username, disabled_at, disabled_reason FROM users WHERE id = ?').get(userId);
      if (!user) throw httpError(404, 'User not found.');

      db.prepare("UPDATE users SET disabled_at = NULL, disabled_reason = '' WHERE id = ?").run(user.id);
      db.prepare(
        `INSERT INTO admin_action_log (action, user_id, previous_username, new_username, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'enable',
        user.id,
        user.username,
        user.username,
        JSON.stringify({ previousDisabledAt: user.disabled_at || null, previousReason: user.disabled_reason || '' }),
        nowIso()
      );
      return getAdminUser(user.id);
    })();

    res.json({ user: updated });
  })
);

app.get(
  '/admin/api/reports',
  route((req, res) => {
    const limit = parseBoundedInteger(req.query.limit, 50, { min: 1, max: 100 });
    const offset = parseBoundedInteger(req.query.offset, 0, { min: 0, max: 100_000 });
    const status = String(req.query.status || '').trim().toLowerCase();
    const filters = [];
    const params = [];

    if (status) {
      if (!reportStatuses.has(status)) throw httpError(400, 'Invalid report status.');
      filters.push('br.status = ?');
      params.push(status);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM bug_reports br ${where}`).get(...params).count;
    const reports = db
      .prepare(
        `SELECT br.id, br.user_id, br.body, br.path, br.status, br.created_at, u.username, u.email
         FROM bug_reports br
         LEFT JOIN users u ON u.id = br.user_id
         ${where}
         ORDER BY br.created_at DESC, br.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map(safeReport);

    res.json({ reports, total: Number(total || 0), limit, offset });
  })
);

app.patch(
  '/admin/api/reports/:id/status',
  route((req, res) => {
    const reportId = parseId(req.params.id, 'Report id');
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!reportStatuses.has(status)) throw httpError(400, 'Invalid report status.');

    const info = db.prepare('UPDATE bug_reports SET status = ? WHERE id = ?').run(status, reportId);
    if (!info.changes) throw httpError(404, 'Report not found.');
    const report = db
      .prepare(
        `SELECT br.id, br.user_id, br.body, br.path, br.status, br.created_at, u.username, u.email
         FROM bug_reports br
         LEFT JOIN users u ON u.id = br.user_id
         WHERE br.id = ?`
      )
      .get(reportId);
    res.json({ report: safeReport(report) });
  })
);

app.use('/admin/api', (req, res) => {
  res.status(404).json({ error: { message: 'Not found.', status: 404 } });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
  res.status(status).json({
    error: {
      message: status >= 500 ? 'Something went wrong.' : err.message,
      status
    }
  });
});

const server = app.listen(adminPort, adminHost, () => {
  console.log(`Albums admin listening on http://${adminHost}:${adminPort}`);
});

function shutdown(signal) {
  console.log(`${signal} received. Closing admin HTTP server and SQLite database.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    try {
      closeDatabase();
    } catch (closeError) {
      console.error(closeError);
      process.exitCode = 1;
    }
    process.exit();
  });

  setTimeout(() => {
    console.error('Shutdown timed out.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
