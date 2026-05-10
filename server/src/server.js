import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { albumKey, closeDatabase, db, normalizeText, nowIso, trackKey, transaction } from '@albums/shared/db';
import { config } from '@albums/shared/config';
import { exploreLists as staticExploreLists } from './explore-data.js';
import { createMetadataWorker } from './metadata-worker.js';
import {
  enqueueMetadataJob,
  metadataQueueDiagnostics,
  pruneMetadataJobs
} from './metadata-jobs.js';
import {
  albumHydrationStatus,
  hydrationStatusCounts,
  markHydrationJobStatus,
  upsertAlbumHydrationStatus
} from './hydration-status.js';
import {
  cachedLocalCover,
  coverSourceForAlbum,
  downloadAlbumCover,
  isLocalCoverPublicPath,
  localCoverCacheSummary,
  localCoverExists,
  pruneLocalCoverCache,
  rememberCoverSource,
  safeCoverPublicPath,
  serveLocalCover
} from './local-cover-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const publicDir = path.join(repoRoot, 'web', 'dist');
if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
  console.error(`web/dist/index.html missing at ${publicDir}. Run \`npm run build\` first.`);
  process.exit(1);
}
const app = express();

const avatarColors = ['#4f8cff', '#15b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#22c55e', '#f97316', '#06b6d4'];
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const rateLimitBuckets = new Map();
let lastRateLimitSweep = 0;
const musicPlatforms = new Set(['spotify', 'youtube_music', 'apple_music', 'tidal', 'soundcloud', 'bandcamp', 'deezer', 'na']);
const platformAccents = {
  spotify: '#1db954',
  youtube_music: '#ff0033',
  apple_music: '#fa243c',
  tidal: '#00ffff',
  soundcloud: '#ff5500',
  bandcamp: '#1da0c3',
  deezer: '#a238ff',
  na: '#ff0033'
};
const exploreCoverMemoryCache = new Map();
const albumLookupMemoryCache = new Map();
const imageProbeMemoryCache = new Map();
const albumSearchRefreshes = new Map();
const coverProbeRefreshes = new Map();
const albumLevelTrackKey = '__album__';
const hiddenExploreSlugs = new Set(['before-you-die', 'modern-classics', 'hip-hop-foundations', 'famous-band-essentials']);
const maxAlbumsPerList = 500;
const metadataUserAgent = `AlbumsToListenTo/0.1 (${config.appOrigin})`;
const metadataCacheMaxEntries = 5000;
const albumLookupCacheTtlMs = 20 * 60 * 1000;
const searchCacheTtlMs = config.searchCacheTtlHours * 60 * 60 * 1000;
const searchCacheStaleRetentionMs = Math.max(searchCacheTtlMs * 7, 7 * 24 * 60 * 60 * 1000);
const coverProbeSuccessTtlMs = config.coverProbeSuccessTtlHours * 60 * 60 * 1000;
const coverProbeFailureTtlMs = config.coverProbeFailureTtlHours * 60 * 60 * 1000;
const activeVisitorWindowMs = 120 * 1000;
const activeVisitorRetentionMs = 10 * 60 * 1000;
const slowRequestMs = parsePositiveInteger(process.env.SLOW_REQUEST_MS, 750, { min: 1, max: 60_000 });
let musicBrainzQueue = Promise.resolve();
let lastMusicBrainzRequestAt = 0;

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  if (!config.isProduction || req.secure || isLocalRequestHost(req)) {
    next();
    return;
  }

  res.redirect(308, `${config.appOrigin}${req.originalUrl || '/'}`);
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProduction ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: false
        }
      : false,
    referrerPolicy: { policy: 'same-origin' }
  })
);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(compression());
app.use(logApiRequest);
app.use(validateRequestOrigin);
app.use(express.json({ limit: '2mb' }));
app.use(loadSession);
app.use(appAvailabilityGate);
app.get('/media/covers/:file', serveLocalCover);
app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      if (/[\\/]assets[\\/].+-[A-Za-z0-9_-]+\.(js|css|woff2?|ttf|otf|eot|svg|png|jpg|webp|avif)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (/\.(html|js|css|json)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  })
);

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

function cachePublic(res, maxAgeSeconds, staleSeconds = maxAgeSeconds) {
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleSeconds}`);
}

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function isLocalRequestHost(req) {
  const host = String(req.get('host') || '').trim().toLowerCase();
  const endBracket = host.startsWith('[') ? host.indexOf(']') : -1;
  const hostname = endBracket > -1 ? host.slice(1, endBracket) : host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function rateLimitError(message, retryAfterSeconds) {
  const error = httpError(429, message);
  error.retryAfter = retryAfterSeconds;
  return error;
}

function requestOrigin(req) {
  const host = req.get('host');
  if (!host) return config.appOrigin;
  return `${req.protocol}://${host}`;
}

function originAllowed(origin, req) {
  try {
    const parsedOrigin = new URL(origin).origin;
    return config.allowedOrigins.includes(parsedOrigin) || (!config.isProduction && parsedOrigin === requestOrigin(req));
  } catch {
    return false;
  }
}

function validateRequestOrigin(req, res, next) {
  if (!req.path.startsWith('/api/') || safeMethods.has(req.method)) {
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

function localHostFromHeader(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? '' : host.slice(1, end);
  }
  return host.split(':')[0];
}

function isLocalAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function isPrivateProxyAddress(value) {
  const address = String(value || '').trim().toLowerCase().replace(/^::ffff:/, '');
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

function requireLocalRequest(req) {
  const host = localHostFromHeader(req.get('host'));
  const localHostHeader = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const localConnection = isLocalAddress(req.socket.remoteAddress) || isPrivateProxyAddress(req.socket.remoteAddress);
  if (!localHostHeader || !localConnection) {
    throw httpError(403, 'Diagnostics are only available from localhost.');
  }
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimitIdentity(req) {
  return req.user ? `user:${req.user.id}` : `ip:${clientIp(req)}`;
}

function sweepRateLimits(now) {
  if (now - lastRateLimitSweep < 60_000) return;
  lastRateLimitSweep = now;
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}

function enforceRateLimit(req, scope, { limit, windowMs, key = rateLimitIdentity(req), message = 'Too many requests. Try again shortly.' }) {
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
    throw rateLimitError(message, Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
  }
}

function fallbackSafeApiPath(pathname) {
  const pathValue = String(pathname || '');
  if (pathValue.startsWith('/api/share/')) return '/api/share/:token';
  if (pathValue.startsWith('/api/invites/')) return pathValue.replace(/^\/api\/invites\/[^/]+/, '/api/invites/:token');
  if (pathValue.startsWith('/api/history/')) return pathValue.replace(/^\/api\/history\/[^/]+/, '/api/history/:token');
  return pathValue
    .split('/')
    .map((segment) => (segment.length >= 24 && /^[a-zA-Z0-9_-]+$/.test(segment) ? ':opaque' : segment))
    .join('/');
}

function safeRoutePath(req) {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') return routePath;
  return fallbackSafeApiPath(req.path);
}

function logApiRequest(req, res, next) {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const slow = durationMs >= slowRequestMs;
    if (req.path === '/api/health' && res.statusCode < 400 && !slow) return;
    console.log(
      JSON.stringify({
        event: 'api_request',
        requestId,
        method: req.method,
        path: safeRoutePath(req),
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        slow
      })
    );
  });
  next();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function fileSize(pathname) {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return 0;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function safeAvatarDataUrl(value) {
  try {
    return validateAvatarDataUrl(value);
  } catch {
    return '';
  }
}

function avatarBytesMatchMime(mime, bytes) {
  if (mime === 'png') {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mime === 'jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === 'webp') {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mime === 'gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return false;
}

function safeExternalImageUrl(value) {
  const text = String(value || '').trim();
  const localCoverPath = safeCoverPublicPath(text);
  if (localCoverPath) return localCoverPath;
  if (!text || text.length > 700) return '';
  try {
    const url = new URL(text);
    if (url.protocol === 'https:') return url.href;
    if (!config.isProduction && url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      return url.href;
    }
  } catch {
    return '';
  }
  return '';
}

function validateCoverUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const safeUrl = safeExternalImageUrl(text);
  if (!safeUrl) throw httpError(400, 'Cover image URL must be HTTPS or a cached Turntable cover.');
  return safeUrl;
}

function publicUser(row, options = {}) {
  if (!row) return null;
  const musicPlatform = row.music_platform || 'na';
  const user = {
    id: row.id,
    username: row.username,
    avatarColor: row.avatar_color,
    avatarUrl: safeAvatarDataUrl(row.avatar_data_url),
    createdAt: row.created_at
  };
  if (options.includePrivate) {
    user.email = row.email;
    user.historyToken = row.history_token;
    user.musicPlatform = musicPlatform;
    user.accentColor = row.accent_color || platformAccent(musicPlatform);
    user.accentCustom = Boolean(row.accent_color);
    user.historyVisibility = row.history_visibility;
    user.themePreference = row.theme_preference;
  }
  return user;
}

function normalizeMusicPlatform(value) {
  const platform = String(value || 'na').trim().toLowerCase();
  return musicPlatforms.has(platform) ? platform : 'na';
}

function platformAccent(value) {
  return platformAccents[normalizeMusicPlatform(value)] || platformAccents.na;
}

function validateAccentColor(value) {
  if (value === null || value === undefined || value === '') return '';
  const color = String(value).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    throw httpError(400, 'Accent color must be a hex color like #1db954.');
  }
  return color;
}

function albumExternalUrl(album, platform = 'na') {
  const query = encodeURIComponent(`${album.title || ''} ${album.artist || ''}`.trim());
  const chosen = normalizeMusicPlatform(platform);
  if (chosen === 'spotify') return `https://open.spotify.com/search/${query}`;
  if (chosen === 'apple_music') return `https://music.apple.com/us/search?term=${query}`;
  if (chosen === 'tidal') return `https://listen.tidal.com/search?q=${query}`;
  if (chosen === 'soundcloud') return `https://soundcloud.com/search/albums?q=${query}`;
  if (chosen === 'bandcamp') return `https://bandcamp.com/search?q=${query}&item_type=a`;
  if (chosen === 'deezer') return `https://www.deezer.com/search/${query}/album`;
  return `https://music.youtube.com/search?q=${query}`;
}

function validateAvatarDataUrl(value) {
  const dataUrl = String(value || '').trim();
  if (!dataUrl) return '';
  if (dataUrl.length > 700_000) {
    throw httpError(400, 'Profile picture is too large. Use an image under about 500 KB.');
  }
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    throw httpError(400, 'Profile picture must be a PNG, JPG, WEBP, or GIF image.');
  }
  const mime = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const base64 = match[2];
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > 512_000 || !avatarBytesMatchMime(mime, bytes)) {
    throw httpError(400, 'Profile picture must be a valid image under about 500 KB.');
  }
  return `data:image/${mime};base64,${base64}`;
}

function avatarFor(value) {
  const normalized = normalizeText(value);
  const first = normalized.charCodeAt(0) || 0;
  return avatarColors[first % avatarColors.length];
}

function setSessionCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/'
  });
}

function createSession(res, userId) {
  const token = randomToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tokenHash, userId, expiresAt, nowIso(), nowIso());

  setSessionCookie(res, token);
}

function deleteCurrentSession(req) {
  if (req.sessionTokenHash) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
    req.sessionTokenHash = null;
  }
}

function replaceCurrentSession(req, res, userId) {
  deleteCurrentSession(req);
  createSession(res, userId);
}

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

function loadSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.cookieName];
  req.user = null;
  req.sessionTokenHash = null;

  if (!token) {
    next();
    return;
  }

  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    clearSessionCookie(res);
    next();
    return;
  }

  if (row.disabled_at) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    clearSessionCookie(res);
    next();
    return;
  }

  req.user = publicUser(row, { includePrivate: true });
  req.sessionTokenHash = tokenHash;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
  next();
}

function settingValue(key, fallback = '') {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? fallback;
}

function maintenanceModeEnabled() {
  return settingValue('maintenance_mode', '0') === '1';
}

function maintenancePageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Maintenance mode</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #151922; }
      main { width: min(520px, calc(100vw - 40px)); }
      h1 { margin: 0 0 10px; font-size: 1.65rem; }
      p { margin: 0; color: #5d687a; line-height: 1.5; }
      @media (prefers-color-scheme: dark) {
        body { background: #101318; color: #f2f4f8; }
        p { color: #a7afbf; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Maintenance mode: public site closed.</h1>
      <p>The album list is temporarily unavailable while maintenance is enabled. Admin controls remain available separately.</p>
    </main>
  </body>
</html>`;
}

function appAvailabilityGate(req, res, next) {
  if (!maintenanceModeEnabled()) {
    next();
    return;
  }

  if (req.path.startsWith('/admin') || req.path === '/api/health' || req.path === '/api/ops/diagnostics') {
    next();
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  if (req.path.startsWith('/api/')) {
    res.status(503).json({
      error: {
        message: 'Maintenance mode: public site closed.',
        status: 503
      },
      maintenanceMode: true
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(503).type('text/plain').send('Maintenance mode: public site closed.');
    return;
  }

  res.status(503).type('html').send(maintenancePageHtml());
}

function requireUser(req) {
  if (!req.user) throw httpError(401, 'You need to log in first.');
  return req.user;
}

function checkAuthThrottle(req) {
  const windowMs = 10 * 60 * 1000;
  enforceRateLimit(req, 'auth-ip', {
    limit: 30,
    windowMs,
    key: `ip:${clientIp(req)}`,
    message: 'Too many login attempts. Try again in a few minutes.'
  });

  const identifier = normalizeText(req.body?.identifier || req.body?.email || req.body?.username || '');
  if (identifier) {
    enforceRateLimit(req, 'auth-identifier', {
      limit: 12,
      windowMs,
      key: `${clientIp(req)}:${identifier}`,
      message: 'Too many login attempts. Try again in a few minutes.'
    });
  }
}

function limitAlbumSearch(req) {
  enforceRateLimit(req, 'album-search', {
    limit: 30,
    windowMs: 60 * 1000,
    message: 'Album search is temporarily rate limited. Try again shortly.'
  });
}

function limitAlbumLookup(req) {
  enforceRateLimit(req, 'album-lookup', {
    limit: 60,
    windowMs: 5 * 60 * 1000,
    message: 'Album metadata lookup is temporarily rate limited. Try again shortly.'
  });
}

function limitCoverRefresh(req, albumId) {
  const identity = rateLimitIdentity(req);
  enforceRateLimit(req, 'cover-refresh-user', {
    limit: 12,
    windowMs: 60 * 60 * 1000,
    key: identity,
    message: 'Cover refreshes are temporarily rate limited. Try again later.'
  });
  enforceRateLimit(req, 'cover-refresh-album', {
    limit: 3,
    windowMs: 10 * 60 * 1000,
    key: `${identity}:${albumId}`,
    message: 'That album cover was refreshed recently. Try again in a few minutes.'
  });
}

function limitExploreCoverLookup(req) {
  enforceRateLimit(req, 'explore-cover', {
    limit: 80,
    windowMs: 5 * 60 * 1000,
    message: 'Cover lookup is temporarily rate limited. Try again shortly.'
  });
}

function limitAvatarUpload(req) {
  enforceRateLimit(req, 'avatar-upload', {
    limit: 10,
    windowMs: 60 * 60 * 1000,
    message: 'Profile photo updates are temporarily rate limited. Try again later.'
  });
}

function limitChatMessage(req) {
  enforceRateLimit(req, 'chat-message', {
    limit: 30,
    windowMs: 60 * 1000,
    message: 'Chat messages are temporarily rate limited. Try again shortly.'
  });
}

function limitInviteSending(req) {
  enforceRateLimit(req, 'invite-send', {
    limit: 30,
    windowMs: 60 * 60 * 1000,
    message: 'Invite sending is temporarily rate limited. Try again later.'
  });
}

function limitBugReport(req) {
  enforceRateLimit(req, 'bug-report-burst', {
    limit: 3,
    windowMs: 10 * 60 * 1000,
    message: 'Bug reports are temporarily rate limited. Try again later.'
  });
  enforceRateLimit(req, 'bug-report-day', {
    limit: 12,
    windowMs: 24 * 60 * 60 * 1000,
    message: 'Bug reports are temporarily rate limited. Try again later.'
  });
}

function limitDbWrite(req, scope = 'db-write') {
  enforceRateLimit(req, scope, {
    limit: 180,
    windowMs: 10 * 60 * 1000,
    message: 'Changes are temporarily rate limited. Try again shortly.'
  });
}

function validateAccountInput({ username, email, password, musicPlatform }) {
  const cleanUsername = clampText(username, 30);
  const cleanEmail = normalizeEmail(email);
  const cleanPassword = String(password || '');

  if (!/^[a-zA-Z0-9_ -]{3,30}$/.test(cleanUsername)) {
    throw httpError(400, 'Username must be 3-30 characters and use letters, numbers, spaces, underscores, or dashes.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw httpError(400, 'Enter a valid email address.');
  }
  if (cleanPassword.length < 8) {
    throw httpError(400, 'Password must be at least 8 characters.');
  }

  return { username: cleanUsername, email: cleanEmail, password: cleanPassword, musicPlatform: normalizeMusicPlatform(musicPlatform) };
}

function uniqueTokenFor(table, column) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomToken(18);
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(token);
    if (!exists) return token;
  }
  throw httpError(500, 'Could not create a unique token.');
}

function createList(ownerUserId, kind, name) {
  const info = db
    .prepare(
      `INSERT INTO lists
       (owner_user_id, kind, name, share_token, invite_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerUserId,
      kind,
      clampText(name || (kind === 'personal' ? 'Albums to Listen To' : 'Shared Albums'), 80),
      uniqueTokenFor('lists', 'share_token'),
      uniqueTokenFor('lists', 'invite_token'),
      nowIso(),
      nowIso()
    );

  db.prepare('INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
    info.lastInsertRowid,
    ownerUserId,
    'owner',
    nowIso()
  );

  return Number(info.lastInsertRowid);
}

const ensurePersonalList = transaction((userId) => {
  const existing = db.prepare('SELECT id FROM lists WHERE owner_user_id = ? AND kind = ?').get(userId, 'personal');
  if (existing) return existing.id;
  return createList(userId, 'personal', 'Albums to Listen To');
});

function getMember(listId, userId) {
  if (!userId) return null;
  return db
    .prepare(
      `SELECT lm.*, u.username, u.avatar_color
       FROM list_members lm
       JOIN users u ON u.id = lm.user_id
       WHERE lm.list_id = ? AND lm.user_id = ?`
    )
    .get(listId, userId);
}

function getListOrThrow(listId) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list) throw httpError(404, 'List not found.');
  return list;
}

function assertCanView(list, user, allowShare = false) {
  const member = getMember(list.id, user?.id);
  const publicReadable = list.visibility === 'public' || (allowShare && list.visibility === 'unlisted');
  if (!member && !publicReadable) throw httpError(404, 'List not found.');
  return member;
}

function assertCanEdit(list, user) {
  const member = assertCanView(list, user);
  if (!member || !['owner', 'editor'].includes(member.role)) {
    throw httpError(403, 'You do not have edit access to this list.');
  }
  return member;
}

function assertCanManage(list, user) {
  const member = assertCanView(list, user);
  if (!member || member.role !== 'owner') {
    throw httpError(403, 'Only the owner can manage this list.');
  }
  return member;
}

function getUserLists(userId) {
  return db
    .prepare(
      `SELECT l.*,
        lm.role,
        owner.username AS owner_username,
        COUNT(DISTINCT la.id) AS album_count,
        COUNT(DISTINCT members.user_id) AS member_count
       FROM list_members lm
       JOIN lists l ON l.id = lm.list_id
       JOIN users owner ON owner.id = l.owner_user_id
       LEFT JOIN list_albums la ON la.list_id = l.id
       LEFT JOIN list_members members ON members.list_id = l.id
       WHERE lm.user_id = ?
       GROUP BY l.id
       ORDER BY l.kind = 'personal' DESC, l.updated_at DESC`
    )
    .all(userId)
    .map(formatListSummary);
}

function getPendingInvites(userId) {
  return db
    .prepare(
      `SELECT li.id, li.role, li.created_at, l.id AS list_id, l.name AS list_name,
              inviter.username AS inviter_username, inviter.avatar_color AS inviter_avatar_color,
              inviter.avatar_data_url AS inviter_avatar_data_url
       FROM list_invites li
       JOIN lists l ON l.id = li.list_id
       JOIN users inviter ON inviter.id = li.inviter_user_id
       WHERE li.invitee_user_id = ? AND li.status = 'pending'
       ORDER BY li.created_at DESC`
    )
    .all(userId)
    .map((invite) => ({
      id: invite.id,
      role: invite.role,
      createdAt: invite.created_at,
      list: {
        id: invite.list_id,
        name: invite.list_name
      },
      inviter: {
        username: invite.inviter_username,
        avatarColor: invite.inviter_avatar_color,
        avatarUrl: safeAvatarDataUrl(invite.inviter_avatar_data_url)
      },
      listId: invite.list_id,
      listName: invite.list_name,
      inviterUsername: invite.inviter_username,
      inviterAvatarColor: invite.inviter_avatar_color,
      inviterAvatarUrl: safeAvatarDataUrl(invite.inviter_avatar_data_url)
    }));
}

function searchUsers(query, viewerUserId) {
  const raw = clampText(query, 120);
  const normalized = normalizeText(raw);
  if (normalized.length < 2 && !raw.includes('@')) return [];

  const rows = [];
  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      rows.push(
        ...db
          .prepare(
            `SELECT id, username, avatar_color, avatar_data_url
             FROM users
             WHERE id != ? AND email_normalized = ?
               AND disabled_at IS NULL
             LIMIT 1`
          )
          .all(viewerUserId || 0, email)
      );
    }
  }

  if (normalized.length >= 2) {
    const like = `%${normalized}%`;
    rows.push(
      ...db
        .prepare(
          `SELECT id, username, avatar_color, avatar_data_url
           FROM users
           WHERE id != ? AND username_normalized LIKE ?
             AND disabled_at IS NULL
           ORDER BY username_normalized
           LIMIT 10`
        )
        .all(viewerUserId || 0, like)
    );
  }

  return uniqueBy(rows, (user) => user.id)
    .slice(0, 10)
    .map((user) => ({
      id: user.id,
      username: user.username,
      avatarColor: user.avatar_color,
      avatarUrl: safeAvatarDataUrl(user.avatar_data_url)
    }));
}

function formatListSummary(row, options = {}) {
  const summary = {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    kind: row.kind,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    showRatings: Boolean(row.show_ratings),
    role: row.role,
    albumCount: row.album_count || 0,
    memberCount: row.member_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (options.includeShareToken) summary.shareToken = row.share_token;
  if (options.includeInviteToken) summary.inviteToken = row.invite_token;
  return summary;
}

function listMembers(listId) {
  return db
    .prepare(
      `SELECT lm.user_id, lm.role, lm.joined_at, u.username, u.avatar_color, u.avatar_data_url
       FROM list_members lm
       JOIN users u ON u.id = lm.user_id
       WHERE lm.list_id = ?
       ORDER BY lm.role = 'owner' DESC, u.username COLLATE NOCASE`
    )
    .all(listId)
    .map((member) => ({
      userId: member.user_id,
      username: member.username,
      avatarColor: member.avatar_color,
      avatarUrl: safeAvatarDataUrl(member.avatar_data_url),
      role: member.role,
      joinedAt: member.joined_at
    }));
}

function sanitizeTracks(value) {
  const rawTracks = Array.isArray(value) ? value : [];
  return rawTracks
    .map((track, index) => {
      const discNumber = Number(track?.discNumber ?? track?.disc_number ?? track?.disc ?? 1);
      const position = Number(track?.position ?? track?.trackNumber ?? index + 1);
      return {
        title: clampText(typeof track === 'string' ? track : track?.title, 160),
        keyTitle: clampText(typeof track === 'string' ? track : track?.keyTitle || track?.title, 160),
        trackKey: clampText(typeof track === 'string' ? '' : track?.trackKey || track?.track_key, 220),
        discNumber: Number.isInteger(discNumber) && discNumber > 0 ? discNumber : 1,
        position: Number.isInteger(position) && position > 0 ? position : index + 1,
        inputIndex: index
      };
    })
    .filter((track) => track.title)
    .sort((a, b) => a.discNumber - b.discNumber || a.position - b.position || a.inputIndex - b.inputIndex)
    .slice(0, 80)
    .map((track, index) => ({
      title: track.title,
      discNumber: track.discNumber,
      position: index + 1,
      trackKey: track.trackKey || trackKey(track.keyTitle || track.title, index + 1)
    }));
}

function upgradeArtwork(url, size = 600) {
  if (!url) return '';
  return String(url).replace(/\/\d+x\d+bb\.(jpg|png|webp)$/i, `/${size}x${size}bb.$1`);
}

function itunesCountry(req) {
  const country = String(req.query.country || 'US').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : 'US';
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': metadataUserAgent
      }
    });
    if (!response.ok) throw httpError(502, 'Album metadata service is not responding.');
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchMusicBrainzJson(url) {
  const task = musicBrainzQueue.then(async () => {
    const waitMs = Math.max(0, lastMusicBrainzRequestAt + 1100 - Date.now());
    if (waitMs) await delay(waitMs);
    lastMusicBrainzRequestAt = Date.now();
    return fetchJson(url);
  });
  musicBrainzQueue = task.catch(() => {});
  return task;
}

function cacheTextKey(value) {
  return String(value || '').trim().toLowerCase().normalize('NFKC').slice(0, 160);
}

function cacheHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function searchCacheSource(country = 'US') {
  return `country:${String(country || 'US').trim().toUpperCase().slice(0, 8) || 'US'}`;
}

function searchCacheKey(term, country = 'US') {
  return `${searchCacheSource(country)}:${cacheTextKey(term)}`;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cachedSearchResults(searchKey) {
  const row = db.prepare('SELECT * FROM album_search_cache WHERE search_key = ?').get(searchKey);
  if (!row) return null;
  return {
    results: parseJsonArray(row.results_json),
    expiresAt: row.expires_at || null,
    fresh: !row.expires_at || row.expires_at > nowIso()
  };
}

function saveSearchResults(searchKeyValue, query, normalizedQuery, country, results) {
  const updatedAt = nowIso();
  const expiresAt = new Date(Date.now() + searchCacheTtlMs).toISOString();
  const safeResults = Array.isArray(results) ? results : [];
  db.prepare(
    `INSERT INTO album_search_cache
       (search_key, query, normalized_query, results_json, source, result_count, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(search_key) DO UPDATE SET
       query = excluded.query,
       normalized_query = excluded.normalized_query,
       results_json = excluded.results_json,
       source = excluded.source,
       result_count = excluded.result_count,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`
  ).run(
    searchKeyValue,
    clampText(query, 160),
    normalizedQuery,
    JSON.stringify(safeResults),
    searchCacheSource(country),
    safeResults.length,
    updatedAt,
    updatedAt,
    expiresAt
  );
  pruneSearchCacheRows();
}

async function refreshSearchCache(searchKeyValue, query, normalizedQuery, country) {
  const existing = albumSearchRefreshes.get(searchKeyValue);
  if (existing) return existing;
  const promise = searchAlbumsUncached(query, country)
    .then((results) => {
      saveSearchResults(searchKeyValue, query, normalizedQuery, country, results);
      return results;
    })
    .finally(() => {
      albumSearchRefreshes.delete(searchKeyValue);
    });
  albumSearchRefreshes.set(searchKeyValue, promise);
  return promise;
}

function pruneCache(cache) {
  if (cache.size <= metadataCacheMaxEntries) return;
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (!entry.promise && entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > metadataCacheMaxEntries) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

async function cachedMetadata(cache, key, ttlMs, loader) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing?.promise) return existing.promise;
  if (existing && existing.expiresAt > now) return existing.value;

  const promise = Promise.resolve()
    .then(loader)
    .then(
      (value) => {
        cache.set(key, { value, expiresAt: Date.now() + ttlMs });
        pruneCache(cache);
        return value;
      },
      (error) => {
        if (cache.get(key)?.promise === promise) cache.delete(key);
        throw error;
      }
    );

  cache.set(key, { promise, expiresAt: now + ttlMs });
  pruneCache(cache);
  return promise;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function safeProbeImageUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 1000) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return '';
    const ipVersion = net.isIP(hostname);
    if (ipVersion === 4 && isPrivateIpv4(hostname)) return '';
    if (ipVersion === 6) {
      if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) return '';
    }
    return url.href;
  } catch {
    return '';
  }
}

function contentRangeTotal(value) {
  const match = String(value || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) || null : null;
}

function coverProbeFailureTtl(statusCode, failureReason) {
  if (statusCode === 404 || statusCode === 410) return 24 * 60 * 60 * 1000;
  if (statusCode === 429 || statusCode >= 500 || failureReason === 'timeout') return 6 * 60 * 60 * 1000;
  return coverProbeFailureTtlMs;
}

function cachedCoverProbe(safeUrl) {
  const row = db.prepare('SELECT * FROM cover_probe_cache WHERE url_hash = ?').get(cacheHash(safeUrl));
  if (!row || row.expires_at <= nowIso()) return null;
  return Boolean(row.ok);
}

function saveCoverProbe(safeUrl, result) {
  const ok = result.ok ? 1 : 0;
  const checkedAt = nowIso();
  const statusCode = result.statusCode ? Number(result.statusCode) : null;
  const failureReason = clampText(result.failureReason || '', 160);
  const ttlMs = ok ? coverProbeSuccessTtlMs : coverProbeFailureTtl(statusCode || 0, failureReason);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    `INSERT INTO cover_probe_cache
       (url_hash, url, ok, status_code, content_type, byte_size, final_url, failure_reason, checked_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url_hash) DO UPDATE SET
       url = excluded.url,
       ok = excluded.ok,
       status_code = excluded.status_code,
       content_type = excluded.content_type,
       byte_size = excluded.byte_size,
       final_url = excluded.final_url,
       failure_reason = excluded.failure_reason,
       checked_at = excluded.checked_at,
       expires_at = excluded.expires_at`
  ).run(
    cacheHash(safeUrl),
    safeUrl,
    ok,
    statusCode,
    clampText(result.contentType || '', 120),
    result.byteSize === undefined ? null : Number(result.byteSize) || null,
    clampText(result.finalUrl || '', 1000),
    failureReason,
    checkedAt,
    expiresAt
  );
  pruneCoverProbeCacheRows();
}

async function probeImageUrl(safeUrl) {
  const existing = coverProbeRefreshes.get(safeUrl);
  if (existing) return existing;
  const promise = (async () => {
    let lastStatusCode = null;
    let lastContentType = '';
    let lastFinalUrl = '';
    let lastByteSize = null;
    let lastFailureReason = 'not_image';

    for (const method of ['HEAD', 'GET']) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const headers = {
          Accept: 'image/*',
          'User-Agent': metadataUserAgent
        };
        if (method === 'GET') headers.Range = 'bytes=0-4095';
        const response = await fetch(safeUrl, {
          method,
          signal: controller.signal,
          headers
        });
        lastStatusCode = response.status;
        lastContentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        lastFinalUrl = response.url || safeUrl;
        lastByteSize =
          contentRangeTotal(response.headers.get('content-range')) ||
          Number(response.headers.get('content-length') || 0) ||
          lastByteSize;
        await response.body?.cancel?.();
        if (response.ok && lastContentType.startsWith('image/')) {
          return {
            ok: true,
            statusCode: lastStatusCode,
            contentType: lastContentType,
            byteSize: lastByteSize,
            finalUrl: lastFinalUrl
          };
        }
        lastFailureReason = response.ok ? 'not_image' : `http_${response.status}`;
      } catch (error) {
        lastFailureReason = error?.name === 'AbortError' ? 'timeout' : 'fetch_error';
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      ok: false,
      statusCode: lastStatusCode,
      contentType: lastContentType,
      byteSize: lastByteSize,
      finalUrl: lastFinalUrl,
      failureReason: lastFailureReason
    };
  })().finally(() => {
    coverProbeRefreshes.delete(safeUrl);
  });
  coverProbeRefreshes.set(safeUrl, promise);
  return promise;
}

async function imageUrlWorks(value) {
  const safeUrl = safeExternalImageUrl(value);
  if (!safeUrl) return false;
  if (isLocalCoverPublicPath(safeUrl)) return localCoverExists(safeUrl);
  const probeUrl = safeProbeImageUrl(safeUrl);
  if (!probeUrl) return false;
  const cachedPersistent = cachedCoverProbe(probeUrl);
  if (cachedPersistent !== null) return cachedPersistent;
  const cached = imageProbeMemoryCache.get(probeUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.works;

  const result = await probeImageUrl(probeUrl);
  const works = Boolean(result.ok);
  saveCoverProbe(probeUrl, result);
  imageProbeMemoryCache.set(probeUrl, {
    works,
    expiresAt: Date.now() + (works ? Math.min(coverProbeSuccessTtlMs, 60 * 60 * 1000) : Math.min(coverProbeFailureTtlMs, 15 * 60 * 1000))
  });
  pruneCache(imageProbeMemoryCache);
  return works;
}

async function spotifyAlbumCover(spotifyId) {
  const id = String(spotifyId || '').trim();
  if (!/^[a-zA-Z0-9]+$/.test(id)) return '';
  const url = new URL('https://open.spotify.com/oembed');
  url.searchParams.set('url', `https://open.spotify.com/album/${id}`);
  const data = await fetchJson(url).catch(() => null);
  return safeExternalImageUrl(data?.thumbnail_url);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function compactIdentityText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function compactAlbumIdentity(title, artist) {
  const compactTitle = compactIdentityText(title);
  if (!compactTitle) return '';
  return `${compactIdentityText(artist) || 'unknown'}::${compactTitle}`;
}

function normalizedAsin(value) {
  const asin = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : '';
}

function amazonAsinCoverCandidates(value) {
  const asin = normalizedAsin(value);
  if (!asin) return [];
  return [
    `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg`,
    `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`
  ];
}

function catalogCoverCandidatesForAlbum(album) {
  return safeCoverUrlList(amazonAsinCoverCandidates(album?.asin));
}

function coverCandidatesForLookupAlbum(album) {
  const providerCover = safeExternalImageUrl(album?.coverUrl || album?.cover_url);
  const catalogCovers = catalogCoverCandidatesForAlbum(album);
  if (album?.provider === 'musicbrainz') return safeCoverUrlList([...catalogCovers, providerCover]);
  return safeCoverUrlList([providerCover, ...catalogCovers]);
}

function preferredCoverUrlForAlbum(album) {
  return coverCandidatesForLookupAlbum(album)[0] || '';
}

function japaneseScriptScore(value) {
  return (String(value || '').match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) || []).length;
}

function trackListJapaneseScore(tracks) {
  return (tracks || []).reduce((total, track) => total + japaneseScriptScore(track?.title), 0);
}

function searchVariants(term) {
  const query = clampText(term, 120);
  const variants = [];
  const normalized = normalizeText(query);
  const words = normalized.split(' ').filter(Boolean);
  const fuzzyWords = words.map((word) => (word.endsWith('os') && word.length > 3 ? `${word.slice(0, -2)}oes` : word));
  const fuzzy = fuzzyWords.join(' ');
  if (fuzzy && fuzzy !== normalized) variants.push(fuzzy);
  variants.push(query);
  if (normalized && normalized !== query.toLowerCase().trim()) variants.push(normalized);
  if (!/\balbum\b/i.test(query)) variants.push(`${query} album`);
  return uniqueBy(variants.filter((variant) => variant.trim().length >= 2), (variant) => normalizeText(variant));
}

function musicBrainzPhrase(value) {
  const phrase = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return phrase ? `"${phrase}"` : '';
}

function musicBrainzFieldClause(field, value) {
  const phrase = musicBrainzPhrase(value);
  return phrase ? `${field}:${phrase}` : '';
}

function musicBrainzFuzzyFieldClause(field, value) {
  const words = normalizeText(value).split(' ').filter(Boolean);
  if (words.length !== 1) return '';
  const [word] = words;
  if (word.length < 3 || word.length > 16) return '';
  return `${field}:${word}~`;
}

function musicBrainzFuzzyWordsClause(field, value) {
  const words = rankingWords(value)
    .filter((word) => word.length >= 4 && word.length <= 16)
    .slice(0, 6);
  if (!words.length) return '';
  return `(${words.map((word) => `${field}:${word}~`).join(' AND ')})`;
}

function musicBrainzFieldClauseOptions(field, value, { fuzzy = false } = {}) {
  return uniqueBy(
    [
      musicBrainzFieldClause(field, value),
      fuzzy ? musicBrainzFuzzyFieldClause(field, value) : '',
      fuzzy ? musicBrainzFuzzyWordsClause(field, value) : ''
    ].filter(Boolean),
    (clause) => clause
  );
}

function titleArtistSplitCandidates(term) {
  const words = normalizeText(term).split(' ').filter(Boolean);
  if (words.length < 2) return [];

  const candidates = [];
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index);
    const right = words.slice(index);
    candidates.push({ title: left.join(' '), artist: right.join(' '), titleWords: left.length, artistWords: right.length });
    candidates.push({ title: right.join(' '), artist: left.join(' '), titleWords: right.length, artistWords: left.length });
  }

  return uniqueBy(candidates, (candidate) => `${candidate.title}::${candidate.artist}`)
    .sort((left, right) => splitCandidateScore(right) - splitCandidateScore(left))
    .slice(0, 8);
}

function splitCandidateScore(candidate) {
  let score = 0;
  if (candidate.titleWords <= 4) score += 20 - candidate.titleWords;
  if (candidate.artistWords <= 5) score += 16 - candidate.artistWords;
  if (candidate.titleWords === 1) score += 4;
  if (candidate.artistWords >= 2) score += 3;
  return score;
}

function musicBrainzReleaseSearchQuery(term) {
  const query = clampText(term, 120);
  const clauses = [
    musicBrainzFieldClause('release', query),
    musicBrainzFuzzyWordsClause('release', query),
    musicBrainzFieldClause('artist', query),
    musicBrainzFuzzyFieldClause('artist', query),
    musicBrainzFuzzyWordsClause('artist', query)
  ].filter(Boolean);

  for (const candidate of titleArtistSplitCandidates(query)) {
    const releaseClauses = musicBrainzFieldClauseOptions('release', candidate.title, { fuzzy: candidate.titleWords <= 4 });
    const artistClauses = musicBrainzFieldClauseOptions('artist', candidate.artist, { fuzzy: candidate.artistWords <= 3 });
    for (const releaseClause of releaseClauses) {
      for (const artistClause of artistClauses) {
        clauses.push(`${releaseClause} AND ${artistClause}`);
      }
    }
  }

  const uniqueClauses = uniqueBy(clauses, (clause) => clause).slice(0, 14);
  if (!uniqueClauses.length) return '';
  return `(${uniqueClauses.map((clause) => `(${clause})`).join(' OR ')}) AND (primarytype:album OR primarytype:ep)`;
}

function releaseTitleFallbackScore(candidate) {
  let score = 0;
  if (candidate.titleWords >= 2 && candidate.titleWords <= 8) score += 40;
  if (candidate.artistWords >= 1 && candidate.artistWords <= 5) score += 24;
  if (candidate.titleWords >= candidate.artistWords) score += 8;
  score -= Math.abs(candidate.titleWords - 5);
  return score;
}

function releaseTitleFallbackCandidates(term) {
  const query = clampText(term, 120);
  const words = normalizeText(query).split(' ').filter(Boolean);
  const candidates = [{ title: query, titleWords: words.length, artistWords: 0, score: 0 }];
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index);
    const right = words.slice(index);
    candidates.push({
      title: left.join(' '),
      titleWords: left.length,
      artistWords: right.length
    });
    candidates.push({
      title: right.join(' '),
      titleWords: right.length,
      artistWords: left.length
    });
  }

  return uniqueBy(
    candidates
      .map((candidate) => ({
        ...candidate,
        title: clampText(candidate.title, 120),
        score: candidate.score ?? releaseTitleFallbackScore(candidate)
      }))
      .filter((candidate) => rankingWords(candidate.title).length >= 2)
      .sort((left, right) => right.score - left.score),
    (candidate) => normalizeText(candidate.title)
  )
    .slice(0, 10)
    .map((candidate) => candidate.title);
}

function musicBrainzReleaseTitleFallbackQuery(term) {
  const clauses = releaseTitleFallbackCandidates(term).flatMap((title) =>
    musicBrainzFieldClauseOptions('release', title, {
      fuzzy: rankingWords(title).length <= 6
    })
  );
  const uniqueClauses = uniqueBy(clauses, (clause) => clause).slice(0, 18);
  if (!uniqueClauses.length) return '';
  return `(${uniqueClauses.map((clause) => `(${clause})`).join(' OR ')}) AND (primarytype:album OR primarytype:ep)`;
}

function specialAlbumMatches(term) {
  const normalized = normalizeText(term);
  const queryWordCount = rankingWords(term).length;
  const matches = [];
  const manWhoSoldTheWorldMatch = fuzzyPhraseInQuery(term, 'the man who sold the world');
  const manWhoSoldTheWorldOnly = queryWordCount <= rankingWords('the man who sold the world').length + 1;
  if (
    manWhoSoldTheWorldMatch &&
    (normalized.includes('bowie') || fuzzyPhraseInQuery(term, 'david bowie') || manWhoSoldTheWorldOnly)
  ) {
    matches.push({
      provider: 'musicbrainz',
      providerId: 'mb:8784de2f-5754-3bcf-8b2a-35d327ef74a1',
      title: 'The Man Who Sold the World',
      artist: 'David Bowie',
      releaseYear: 1970,
      trackCount: 9,
      coverUrl: 'https://coverartarchive.org/release/8784de2f-5754-3bcf-8b2a-35d327ef74a1/front-500',
      sourceUrl: 'https://musicbrainz.org/release/8784de2f-5754-3bcf-8b2a-35d327ef74a1'
    });
  }
  if (fuzzyPhraseInQuery(term, 'blackstar') || term.includes('★')) {
    matches.push({
      provider: 'musicbrainz',
      providerId: 'mb:8eb5ae9e-ba52-4a8f-8513-822a5ccde819',
      title: 'Blackstar (★)',
      artist: 'David Bowie',
      releaseYear: 2016,
      trackCount: 7,
      coverUrl: 'https://coverartarchive.org/release/8eb5ae9e-ba52-4a8f-8513-822a5ccde819/front-500',
      sourceUrl: 'https://musicbrainz.org/release/8eb5ae9e-ba52-4a8f-8513-822a5ccde819'
    });
  }
  if (/\b(heroes|heros)\b/.test(normalized)) {
    matches.push({
      provider: 'itunes',
      providerId: '1347894082',
      title: '"Heroes" (2017 Remaster)',
      artist: 'David Bowie',
      releaseYear: 1977,
      trackCount: 10,
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e2/65/b2/e265b2ae-48d5-9dd8-0251-6cd6c6c4eb53/190295842826.jpg/600x600bb.jpg',
      sourceUrl: 'https://music.apple.com/us/album/heroes-2017-remaster/1347894082?uo=4'
    });
  }
  return matches;
}

function musicBrainzArtistCreditName(artistCredits = []) {
  return artistCredits
    .map((credit) => `${credit.name || credit.artist?.name || ''}${credit.joinphrase || ''}`)
    .join('')
    .trim();
}

function musicBrainzCatalogNumbers(release) {
  return uniqueBy(
    (release?.['label-info'] || [])
      .map((item) => clampText(item?.['catalog-number'], 80))
      .filter(Boolean),
    (catalogNumber) => normalizeText(catalogNumber)
  );
}

function formatItunesAlbum(result) {
  return {
    provider: 'itunes',
    providerId: String(result.collectionId),
    title: result.collectionName || '',
    artist: result.artistName || '',
    releaseYear: result.releaseDate ? new Date(result.releaseDate).getUTCFullYear() : null,
    trackCount: result.trackCount || 0,
    coverUrl: safeExternalImageUrl(upgradeArtwork(result.artworkUrl100 || result.artworkUrl60 || '', 600)),
    sourceUrl: result.collectionViewUrl || ''
  };
}

function formatItunesSongAlbum(result) {
  return {
    provider: 'itunes',
    providerId: String(result.collectionId),
    title: result.collectionName || '',
    artist: result.artistName || '',
    releaseYear: result.releaseDate ? new Date(result.releaseDate).getUTCFullYear() : null,
    trackCount: 0,
    coverUrl: safeExternalImageUrl(upgradeArtwork(result.artworkUrl100 || result.artworkUrl60 || '', 600)),
    sourceUrl: result.collectionViewUrl || ''
  };
}

function formatDeezerAlbum(result) {
  return {
    provider: 'deezer',
    providerId: `dz:${result.id}`,
    title: result.title || '',
    artist: result.artist?.name || '',
    releaseYear: result.release_date ? new Date(result.release_date).getUTCFullYear() : null,
    trackCount: result.nb_tracks || 0,
    coverUrl: safeExternalImageUrl(result.cover_xl || result.cover_big || result.cover_medium || result.cover || ''),
    sourceUrl: result.link || ''
  };
}

function formatMusicBrainzSearchAlbum(result) {
  const releaseGroup = result['release-group'] || {};
  const releaseDate = result.date || releaseGroup['first-release-date'] || '';
  const coverUrl = preferredCoverUrlForAlbum({
    provider: 'musicbrainz',
    asin: result.asin,
    coverUrl: `https://coverartarchive.org/release/${result.id}/front-500`
  });
  return {
    provider: 'musicbrainz',
    providerId: `mb:${result.id}`,
    title: releaseGroup.title || result.title || '',
    artist: musicBrainzArtistCreditName(result['artist-credit']) || '',
    releaseYear: releaseDate ? Number(String(releaseDate).slice(0, 4)) : null,
    trackCount: result['track-count'] || 0,
    coverUrl,
    sourceUrl: `https://musicbrainz.org/release/${result.id}`,
    releaseGroupId: releaseGroup.id || ''
  };
}

function likelyNonAlbumRelease(title) {
  const normalized = normalizeText(title);
  return /\b(single|ep|soundtrack|best of|collection|live|karaoke|tribute)\b/.test(normalized);
}

const rankingStopWords = new Set([
  'a',
  'an',
  'the',
  'in',
  'on',
  'of',
  'and',
  'to',
  'for',
  'with',
  'from',
  'album',
  'albums',
  'remaster',
  'remastered',
  'deluxe',
  'edition',
  'expanded',
  'anniversary',
  'explicit',
  'clean',
  'single',
  'ep',
  'live',
  'version',
  'versions'
]);

function fuzzyPhraseInQuery(query, phrase) {
  const queryWords = rankingWords(query);
  const phraseWords = rankingWords(phrase);
  if (!phraseWords.length) return false;
  return wordCoverage(phraseWords, queryWords) >= Math.max(0.75, 1 - 1 / phraseWords.length);
}

function rankingWords(value) {
  return normalizeText(value)
    .split(' ')
    .filter((word) => word && !rankingStopWords.has(word));
}

function editDistanceWithinOne(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let edits = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  return true;
}

function wordsMatch(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return true;
  if (Math.min(left.length, right.length) >= 4 && editDistanceWithinOne(left, right)) return true;
  return false;
}

function wordCoverage(needles, haystack) {
  if (!needles.length) return 0;
  let matches = 0;
  for (const needle of needles) {
    if (haystack.some((word) => wordsMatch(needle, word))) matches += 1;
  }
  return matches / needles.length;
}

function scoreTitleArtistCoverage(title, artist, query) {
  const queryWords = rankingWords(query);
  const titleWords = rankingWords(title);
  const artistWords = rankingWords(artist);
  const combinedWords = [...titleWords, ...artistWords];
  const queryCoverage = wordCoverage(queryWords, combinedWords);
  const titleCoverage = wordCoverage(titleWords, queryWords);
  const artistCoverage = wordCoverage(artistWords, queryWords);

  let score = queryCoverage * 360 + titleCoverage * 260 + artistCoverage * 180;
  if (titleCoverage >= 0.99 && artistCoverage >= 0.66 && queryCoverage >= 0.75) score += 520;
  else if (titleCoverage >= 0.99 && queryCoverage >= 0.45) score += 240;
  if (!titleCoverage && artistCoverage >= 0.99) score += 80;
  return score;
}

function scoreItunesResult(result, query) {
  const normalizedQuery = normalizeText(query);
  const collection = normalizeText(result.collectionName);
  const track = normalizeText(result.trackName);
  const artist = normalizeText(result.artistName);
  const trackCount = Number(result.trackCount || 0);
  const nonAlbumRelease = likelyNonAlbumRelease(result.collectionName);
  let score = 0;
  if (result.wrapperType === 'track') {
    score += nonAlbumRelease ? 40 : 210;
    if (track === normalizedQuery) score += 180;
    else if (track.includes(normalizedQuery)) score += 90;
    if (!nonAlbumRelease) score += 90;
    if (artist !== normalizedQuery) score -= 180;
  } else {
    score += 120;
    if (collection === normalizedQuery) score += 160;
    else if (collection.includes(normalizedQuery)) score += 70;
    if (trackCount >= 6 && trackCount <= 30) score += 150;
    else if (trackCount > 0 && trackCount <= 2) score -= 120;
  }
  score += scoreTitleArtistCoverage(result.collectionName, result.artistName, query);
  if (artist === normalizedQuery) score += 540;
  else if (artist.includes(normalizedQuery)) score += 40;
  if (nonAlbumRelease) score -= 360;
  return score;
}

function scoreDeezerResult(result, query) {
  const normalizedQuery = normalizeText(query);
  const title = normalizeText(result.title);
  const artist = normalizeText(result.artist?.name);
  const trackCount = Number(result.nb_tracks || 0);
  const nonAlbumRelease = likelyNonAlbumRelease(result.title);
  let score = 130;
  if (result.record_type === 'album') score += 80;
  if (title === normalizedQuery) score += 170;
  else if (title && (title.includes(normalizedQuery) || normalizedQuery.includes(title))) score += 70;
  if (artist === normalizedQuery) score += 360;
  else if (artist.includes(normalizedQuery)) score += 60;
  if (trackCount >= 6 && trackCount <= 30) score += 130;
  else if (trackCount > 30) score -= Math.min(160, (trackCount - 30) * 4);
  else if (trackCount > 0 && trackCount <= 2) score -= 120;
  score += scoreTitleArtistCoverage(result.title, result.artist?.name, query);
  if (safeExternalImageUrl(result.cover_xl || result.cover_big || result.cover_medium || result.cover)) score += 40;
  if (nonAlbumRelease) score -= 260;
  return score;
}

function scoreMusicBrainzResult(result, query) {
  const normalizedQuery = normalizeText(query);
  const title = normalizeText(result.title || result['release-group']?.title);
  const artist = normalizeText(musicBrainzArtistCreditName(result['artist-credit']));
  const releaseGroup = result['release-group'] || {};
  const secondaryTypes = new Set(releaseGroup['secondary-types'] || []);
  const primaryType = normalizeText(releaseGroup['primary-type']);
  const releaseYear = result.date ? Number(String(result.date).slice(0, 4)) : null;
  const trackCount = Number(result['track-count'] || 0);
  const mediumCount = Array.isArray(result.media) ? result.media.length : 0;
  let score = Number(result.score || 0);
  if (result.status === 'Official') score += 130;
  else if (result.status === 'Bootleg') score -= 240;
  else score -= 130;
  if (result.country === 'XW') score += 4;
  else if (result.country === 'US') score += 2;
  if (primaryType === 'album') score += 90;
  else if (primaryType === 'ep') score += 22;
  if (primaryType === 'ep' && trackCount >= 3 && trackCount <= 12) score += 28;
  else if (primaryType === 'album' && trackCount >= 6 && trackCount <= 30) score += 18;
  if (trackCount) score += Math.min(trackCount, 30) * 2;
  if (mediumCount > 1) score += Math.min(mediumCount, 4) * 12;
  if (trackCount > 40) score -= 120;
  if (artist === normalizedQuery) score += 140;
  else if (artist.includes(normalizedQuery)) score += 70;
  if (title === normalizedQuery) score += 110;
  else if (title.includes(normalizedQuery)) score += 45;
  score += scoreTitleArtistCoverage(result.title || result['release-group']?.title, artist, query);
  if (Number.isInteger(releaseYear)) score += Math.max(0, 40 - Math.max(0, releaseYear - 1950) * 0.35);
  else score -= 50;
  if (secondaryTypes.has('Live')) score -= 180;
  if (secondaryTypes.has('Compilation')) score -= 80;
  if (secondaryTypes.has('Single')) score -= 360;
  if (likelyNonAlbumRelease(result.title || releaseGroup.title)) score -= 300;
  return score;
}

async function searchMusicBrainzAlbums(term) {
  const query = clampText(term, 120);
  if (query.length < 2) return [];
  const search = musicBrainzReleaseSearchQuery(query);
  if (!search) return [];
  const fetchReleaseSearch = async (searchQuery) => {
    const url = new URL('https://musicbrainz.org/ws/2/release');
    url.searchParams.set('query', searchQuery);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '20');
    const data = await fetchMusicBrainzJson(url);
    return data.releases || [];
  };

  let releases = await fetchReleaseSearch(search);
  if (!releases.length) {
    const fallbackSearch = musicBrainzReleaseTitleFallbackQuery(query);
    if (fallbackSearch && fallbackSearch !== search) releases = await fetchReleaseSearch(fallbackSearch);
  }

  return releases
    .filter((result) => result.id && result.title)
    .map((result) => ({
      ...formatMusicBrainzSearchAlbum(result),
      score: scoreMusicBrainzResult(result, query)
    }));
}

async function searchItunesAlbums(query, country = 'US') {
  const searches = [];
  for (const variant of searchVariants(query)) {
    const albumUrl = new URL('https://itunes.apple.com/search');
    albumUrl.searchParams.set('term', variant);
    albumUrl.searchParams.set('media', 'music');
    albumUrl.searchParams.set('entity', 'album');
    albumUrl.searchParams.set('limit', '18');
    albumUrl.searchParams.set('country', country);
    searches.push(fetchJson(albumUrl));

    const songUrl = new URL('https://itunes.apple.com/search');
    songUrl.searchParams.set('term', variant);
    songUrl.searchParams.set('media', 'music');
    songUrl.searchParams.set('entity', 'song');
    songUrl.searchParams.set('limit', '18');
    songUrl.searchParams.set('country', country);
    searches.push(fetchJson(songUrl));
  }

  const settledSearches = await Promise.allSettled(searches);
  return settledSearches
    .flatMap((result) => (result.status === 'fulfilled' ? result.value.results || [] : []))
    .map((result) => ({
      ...(result.wrapperType === 'track' ? formatItunesSongAlbum(result) : formatItunesAlbum(result)),
      score: scoreItunesResult(result, query)
    }))
    .filter((album) => album.title);
}

async function searchDeezerAlbums(query) {
  const searches = [];
  for (const variant of searchVariants(query)) {
    const url = new URL('https://api.deezer.com/search/album');
    url.searchParams.set('q', variant);
    url.searchParams.set('limit', '15');
    searches.push(fetchJson(url));
  }

  const settledSearches = await Promise.allSettled(searches);
  return settledSearches
    .flatMap((result) => (result.status === 'fulfilled' ? result.value.data || [] : []))
    .map((result) => ({
      ...formatDeezerAlbum(result),
      score: scoreDeezerResult(result, query)
    }))
    .filter((album) => album.title);
}

async function searchAlbumsUncached(term, country = 'US') {
  const query = clampText(term, 120);
  if (query.length < 2) return [];
  const specialMatches = specialAlbumMatches(query);
  const [itunesMatches, musicBrainzMatches, deezerMatches] = await Promise.allSettled([
    searchItunesAlbums(query, country),
    searchMusicBrainzAlbums(query),
    searchDeezerAlbums(query)
  ]);
  const results = [
    ...specialMatches.map((album) => ({ ...album, score: 5000 })),
    ...(itunesMatches.status === 'fulfilled' ? itunesMatches.value : []),
    ...(musicBrainzMatches.status === 'fulfilled' ? musicBrainzMatches.value : []),
    ...(deezerMatches.status === 'fulfilled' ? deezerMatches.value : [])
  ];

  return collapseAlbumSearchResults(results)
    .slice(0, 10)
    .map(({ score, releaseGroupId, groupScore, qualityScore, ...album }) => album);
}

async function searchAlbums(term, country = 'US') {
  const query = clampText(term, 120);
  if (query.length < 2) return [];
  const normalizedQuery = cacheTextKey(query);
  const key = searchCacheKey(query, country);
  const cached = cachedSearchResults(key);
  if (cached) {
    if (!cached.fresh) {
      refreshSearchCache(key, query, normalizedQuery, country).catch((error) => {
        console.error(JSON.stringify({ event: 'search_cache_refresh_failure', searchKey: key, error: String(error?.message || error) }));
      });
    }
    return cached.results;
  }
  return refreshSearchCache(key, query, normalizedQuery, country);
}

function albumSearchQualityScore(album) {
  const trackCount = Number(album.trackCount || 0);
  let score = 0;
  if (album.provider === 'itunes') score += 90;
  else if (album.provider === 'deezer') score += 70;
  else if (album.provider === 'musicbrainz') score += 25;
  if (trackCount) score += Math.min(trackCount, 40) * 3;
  if (trackCount >= 6 && trackCount <= 30) score += 90;
  else if (trackCount > 0 && trackCount <= 2) score -= 120;
  if (album.releaseYear) score += 25;
  else score -= 20;
  if (safeExternalImageUrl(album.coverUrl)) score += 10;
  if (likelyNonAlbumRelease(album.title)) score -= 220;
  return score;
}

function albumProviderSearchKey(album) {
  const provider = String(album.provider || '').trim();
  const providerId = String(album.providerId || '').trim();
  if (!provider || !providerId) return '';
  return `${provider}:${providerId}`;
}

function bestAlbumSearchCandidate(left, right) {
  const leftQuality = albumSearchQualityScore(left);
  const rightQuality = albumSearchQualityScore(right);
  if (leftQuality !== rightQuality) return leftQuality > rightQuality ? left : right;
  const leftScore = Number(left.score || 0);
  const rightScore = Number(right.score || 0);
  if (leftScore !== rightScore) return leftScore > rightScore ? left : right;
  return String(left.artist || '').length <= String(right.artist || '').length ? left : right;
}

function collapseAlbumSearchResults(results) {
  const byProviderId = new Map();
  for (const album of results.filter((item) => item.title)) {
    const providerKey = albumProviderSearchKey(album);
    if (!providerKey) continue;
    const existing = byProviderId.get(providerKey);
    byProviderId.set(providerKey, existing ? bestAlbumSearchCandidate(existing, album) : album);
  }

  const groups = new Map();
  for (const album of byProviderId.values()) {
    const key = compactAlbumIdentity(album.title, album.artist) || album.releaseGroupId || `${album.provider}:${album.providerId}`;
    const group = groups.get(key);
    if (group) group.push(album);
    else groups.set(key, [album]);
  }

  return Array.from(groups.values())
    .map((group) => {
      const groupScore = Math.max(...group.map((album) => Number(album.score || 0)));
      const trackCountMode = mostCommonTrackCount(group);
      const ranked = group
        .map((album) => ({
          ...album,
          groupScore,
          qualityScore: albumSearchQualityScore(album) + canonicalTrackCountScore(album, trackCountMode)
        }))
        .sort((left, right) => right.qualityScore - left.qualityScore || Number(right.score || 0) - Number(left.score || 0));
      return ranked[0];
    })
    .sort((left, right) => right.groupScore - left.groupScore || right.qualityScore - left.qualityScore);
}

function mostCommonTrackCount(group) {
  const counts = new Map();
  for (const album of group) {
    const trackCount = Number(album.trackCount || 0);
    if (!trackCount) continue;
    counts.set(trackCount, (counts.get(trackCount) || 0) + 1);
  }
  let bestCount = 0;
  let bestFrequency = 0;
  for (const [trackCount, frequency] of counts.entries()) {
    if (frequency > bestFrequency || (frequency === bestFrequency && trackCount < bestCount)) {
      bestCount = trackCount;
      bestFrequency = frequency;
    }
  }
  return bestCount;
}

function canonicalTrackCountScore(album, trackCountMode) {
  const trackCount = Number(album.trackCount || 0);
  if (!trackCount || !trackCountMode) return 0;
  if (trackCount === trackCountMode) return 90;
  return -Math.min(160, Math.abs(trackCount - trackCountMode) * 28);
}

async function lookupAlbumUncached(providerId, country = 'US') {
  if (String(providerId || '').startsWith('mb:')) {
    return lookupMusicBrainzRelease(String(providerId).slice(3));
  }
  if (String(providerId || '').startsWith('dz:')) {
    return lookupDeezerAlbum(String(providerId).slice(3));
  }
  const id = String(providerId || '').replace(/[^0-9]/g, '');
  if (!id) throw httpError(400, 'Album id is required.');
  const albumData = await lookupItunesAlbumData(id, country);
  return publicLookupAlbum(await applyNativeItunesTrackTitles(id, country, albumData));
}

function publicLookupAlbum(albumData) {
  const { collection, ...album } = albumData;
  return album;
}

async function lookupItunesAlbumData(id, country = 'US', lang = '') {
  const url = new URL('https://itunes.apple.com/lookup');
  url.searchParams.set('id', id);
  url.searchParams.set('entity', 'song');
  url.searchParams.set('country', country);
  if (lang) url.searchParams.set('lang', lang);
  const data = await fetchJson(url);
  const collection = (data.results || []).find((result) => result.wrapperType === 'collection');
  if (!collection) throw httpError(404, 'Album metadata not found.');
  const tracks = (data.results || [])
    .filter((result) => result.wrapperType === 'track' && result.kind === 'song')
    .sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0))
    .map((track, index) => ({
      title: clampText(track.trackName, 160),
      keyTitle: clampText(track.trackName, 160),
      discNumber: Number(track.discNumber || 1),
      position: index + 1
    }))
    .filter((track) => track.title);

  return {
    ...formatItunesAlbum(collection),
    collection,
    tracks
  };
}

async function applyNativeItunesTrackTitles(id, country, albumData) {
  const baseTracks = albumData.tracks || [];
  if (String(country || 'US').toUpperCase() !== 'JP' && baseTracks.length) {
    const japaneseAlbumData = await lookupItunesAlbumData(id, 'JP', 'ja_jp').catch(() => null);
    if (canUseJapaneseItunesTracks(albumData, japaneseAlbumData)) {
      return {
        ...albumData,
        tracks: overlayTrackTitles(baseTracks, japaneseAlbumData.tracks)
      };
    }
  }

  return albumData;
}

function canUseJapaneseItunesTracks(baseAlbum, japaneseAlbum) {
  const baseTracks = baseAlbum?.tracks || [];
  const japaneseTracks = japaneseAlbum?.tracks || [];
  const baseCollection = baseAlbum?.collection;
  const japaneseCollection = japaneseAlbum?.collection;
  if (!baseCollection || !japaneseCollection || String(baseCollection.collectionId) !== String(japaneseCollection.collectionId)) return false;
  if (!baseTracks.length || baseTracks.length !== japaneseTracks.length) return false;
  if (trackListJapaneseScore(japaneseTracks) <= trackListJapaneseScore(baseTracks)) return false;
  return compactAlbumIdentity(baseCollection.collectionName, baseCollection.artistName) === compactAlbumIdentity(
    japaneseCollection.collectionName,
    japaneseCollection.artistName
  );
}

function overlayTrackTitles(baseTracks, titleTracks) {
  return baseTracks.map((track, index) => ({
    ...track,
    title: titleTracks[index]?.title || track.title,
    keyTitle: track.keyTitle || track.title
  }));
}

async function lookupAlbum(providerId, country = 'US') {
  const key = `${String(country || 'US').toUpperCase()}:${cacheTextKey(providerId)}`;
  return cachedMetadata(albumLookupMemoryCache, key, albumLookupCacheTtlMs, () => lookupAlbumUncached(providerId, country));
}

async function lookupDeezerAlbum(deezerId) {
  const id = String(deezerId || '').replace(/[^0-9]/g, '');
  if (!id) throw httpError(400, 'Album id is required.');
  const data = await fetchJson(new URL(`https://api.deezer.com/album/${id}`));
  if (data?.error || !data.id) throw httpError(404, 'Album metadata not found.');
  const tracks = (data.tracks?.data || [])
    .sort((a, b) => (a.disk_number || 1) - (b.disk_number || 1) || (a.track_position || 0) - (b.track_position || 0))
    .map((track, index) => ({
      title: clampText(track.title, 160),
      keyTitle: clampText(track.title, 160),
      discNumber: Number(track.disk_number || 1),
      position: index + 1
    }))
    .filter((track) => track.title);

  return {
    provider: 'deezer',
    providerId: `dz:${id}`,
    title: data.title || '',
    artist: data.artist?.name || '',
    releaseYear: data.release_date ? new Date(data.release_date).getUTCFullYear() : null,
    trackCount: tracks.length || data.nb_tracks || 0,
    coverUrl: safeExternalImageUrl(data.cover_xl || data.cover_big || data.cover_medium || data.cover || ''),
    sourceUrl: data.link || '',
    tracks
  };
}

async function lookupMusicBrainzRelease(releaseId) {
  const id = String(releaseId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(400, 'Album id is required.');
  const url = new URL(`https://musicbrainz.org/ws/2/release/${id}`);
  url.searchParams.set('inc', 'recordings+artist-credits+release-groups+labels');
  url.searchParams.set('fmt', 'json');
  const data = await fetchMusicBrainzJson(url);
  const tracks = (data.media || [])
    .flatMap((medium, mediumIndex) =>
      (medium.tracks || []).map((track, trackIndex) => ({
        ...track,
        discNumber: Number(medium.position || mediumIndex + 1),
        mediumTrackIndex: trackIndex
      }))
    )
    .map((track, index) => ({
      title: clampText(track.title || track.recording?.title, 160),
      discNumber: Number(track.discNumber || 1),
      position: index + 1
    }))
    .filter((track) => track.title);
  const asin = normalizedAsin(data.asin);
  const coverUrl = preferredCoverUrlForAlbum({
    provider: 'musicbrainz',
    asin,
    coverUrl: `https://coverartarchive.org/release/${id}/front-500`
  });

  return {
    provider: 'musicbrainz',
    providerId: `mb:${id}`,
    title: data.title === '★' ? 'Blackstar (★)' : data.title,
    artist: musicBrainzArtistCreditName(data['artist-credit']) || '',
    releaseYear: data.date ? Number(String(data.date).slice(0, 4)) : null,
    trackCount: tracks.length,
    coverUrl,
    sourceUrl: `https://musicbrainz.org/release/${id}`,
    asin,
    barcode: clampText(data.barcode, 80),
    catalogNumbers: musicBrainzCatalogNumbers(data),
    tracks
  };
}

function scoreCoverCandidate(album, title, artist) {
  const candidateTitle = normalizeText(album.title);
  const candidateArtist = normalizeText(album.artist);
  const targetTitle = normalizeText(title);
  const targetArtist = normalizeText(artist);
  let score = 0;
  if (candidateTitle === targetTitle) score += 500;
  else if (candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle)) score += 220;
  if (targetArtist) {
    if (candidateArtist === targetArtist) score += 300;
    else if (candidateArtist.includes(targetArtist) || targetArtist.includes(candidateArtist)) score += 130;
  }
  if (album.provider === 'itunes') score += 20;
  else if (album.provider === 'deezer') score += 16;
  return score;
}

async function albumCoverCandidates(title, artist, country = 'US') {
  const query = `${title || ''} ${artist || ''}`.trim();
  if (query.length < 2) return [];
  const results = await searchAlbums(query, country).catch(() => []);
  return uniqueBy(
    results
      .filter((album) => safeExternalImageUrl(album.coverUrl))
      .sort((a, b) => scoreCoverCandidate(b, title, artist) - scoreCoverCandidate(a, title, artist)),
    (album) => safeExternalImageUrl(album.coverUrl)
  );
}

function cachedAlbumCoverValue(title, artist) {
  const key = albumKey(title, artist);
  if (!key) return '';
  const localCover = cachedLocalCover(key);
  if (localCover) return localCover;
  const row = db.prepare('SELECT cover_url FROM album_cover_cache WHERE album_key = ?').get(key);
  const cached = safeExternalImageUrl(row?.cover_url);
  if (cached) return cached;
  const imageSource = coverSourceForAlbum(key);
  if (imageSource) return imageSource;
  return '';
}

function cachedAlbumCover(title, artist) {
  const cached = cachedAlbumCoverValue(title, artist);
  if (cached) return cached;
  const key = albumKey(title, artist);
  if (!key) return '';
  const metadata = albumMetadata(key);
  const metadataCover = safeExternalImageUrl(metadata.cover_url);
  if (metadataCover) {
    if (isLocalCoverPublicPath(metadataCover) && !localCoverExists(metadataCover)) return coverSourceForAlbum(key) || '';
    return saveAlbumCover(metadata.title || title, metadata.artist || artist, metadataCover, 'album-metadata');
  }
  return '';
}

function saveAlbumCover(title, artist, coverUrl, source = '') {
  const safeCoverUrl = safeExternalImageUrl(coverUrl);
  const key = albumKey(title, artist);
  if (!key || !safeCoverUrl) return '';
  if (isLocalCoverPublicPath(safeCoverUrl)) return safeCoverUrl;
  rememberCoverSource(key, safeCoverUrl);
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO album_cover_cache (album_key, title, artist, cover_url, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(album_key) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       cover_url = excluded.cover_url,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run(key, clampText(title, 160), clampText(artist, 160), safeCoverUrl, clampText(source, 80), updatedAt);
  upsertAlbumHydrationStatus(
    { albumKey: key, title, artist },
    { coverStatus: 'complete', coverUpdatedAt: updatedAt, lastError: '' }
  );
  clearAlbumCoverLookupFailure(key);
  return safeCoverUrl;
}

function coverLookupFailureDelayMs(attempts) {
  const retryIndex = Math.max(0, Number(attempts || 1) - 1);
  const baseMs = config.coverLookupFailureBaseMinutes * 60 * 1000;
  const maxMs = config.coverLookupFailureMaxHours * 60 * 60 * 1000;
  return Math.min(maxMs, Math.round(baseMs * 2 ** retryIndex));
}

function albumCoverLookupBackoff(albumKeyValue) {
  const key = clampText(albumKeyValue, 320);
  if (!key) return null;
  const row = db.prepare('SELECT * FROM album_cover_lookup_failures WHERE album_key = ?').get(key);
  if (!row || row.next_retry_at <= nowIso()) return null;
  return row;
}

function clearAlbumCoverLookupFailure(albumKeyValue) {
  const key = clampText(albumKeyValue, 320);
  if (!key) return;
  db.prepare('DELETE FROM album_cover_lookup_failures WHERE album_key = ?').run(key);
}

function recordAlbumCoverLookupFailure(title, artist, provider = '', error = '') {
  const cleanTitle = clampText(title, 160);
  if (!cleanTitle) return null;
  const cleanArtist = clampText(artist, 160);
  const key = albumKey(cleanTitle, cleanArtist);
  if (!key) return null;
  const previous = db.prepare('SELECT attempts FROM album_cover_lookup_failures WHERE album_key = ?').get(key);
  const attempts = Number(previous?.attempts || 0) + 1;
  const attemptedAt = nowIso();
  const nextRetryAt = new Date(Date.now() + coverLookupFailureDelayMs(attempts)).toISOString();
  db.prepare(
    `INSERT INTO album_cover_lookup_failures
       (album_key, title, artist, provider, attempts, last_error, last_attempted_at, next_retry_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(album_key) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       provider = excluded.provider,
       attempts = excluded.attempts,
       last_error = excluded.last_error,
       last_attempted_at = excluded.last_attempted_at,
       next_retry_at = excluded.next_retry_at,
       updated_at = excluded.updated_at`
  ).run(
    key,
    cleanTitle,
    cleanArtist,
    clampText(provider, 80),
    attempts,
    clampText(error || 'No working cover found.', 1000),
    attemptedAt,
    nextRetryAt,
    attemptedAt
  );
  return { attempts, nextRetryAt };
}

function safeCoverUrlList(values) {
  return uniqueBy((values || []).map(safeExternalImageUrl).filter(Boolean), (coverUrl) => coverUrl);
}

function storedAlbumCoverCandidates(title, artist) {
  const key = albumKey(title, artist);
  if (!key) return [];
  const rows = [
    { cover_url: cachedLocalCover(key) },
    { cover_url: coverSourceForAlbum(key) },
    ...db.prepare('SELECT cover_url FROM album_cover_cache WHERE album_key = ?').all(key),
    ...db.prepare('SELECT cover_url FROM album_metadata_cache WHERE album_key = ?').all(key)
  ];
  return safeCoverUrlList(rows.map((row) => row.cover_url));
}

function matchingExploreCoverRows(title, artist, coverUrl) {
  return db
    .prepare('SELECT slug, album_index FROM explore_album_covers WHERE title = ? AND artist = ? AND cover_url = ?')
    .all(title || '', artist || '', coverUrl || '');
}

function clearExploreCoverMemory(rows) {
  for (const row of rows) {
    exploreCoverMemoryCache.delete(`${row.slug}:${row.album_index}`);
  }
}

function clearBadAlbumCoverReferences(title, artist, badCoverUrls = []) {
  const key = albumKey(title, artist);
  const badUrls = safeCoverUrlList(badCoverUrls);
  if (!key || !badUrls.length) return;
  for (const badUrl of badUrls) {
    db.prepare('DELETE FROM album_cover_cache WHERE album_key = ? AND cover_url = ?').run(key, badUrl);
    db.prepare("UPDATE album_metadata_cache SET cover_url = '' WHERE album_key = ? AND cover_url = ?").run(key, badUrl);
    db.prepare("UPDATE list_albums SET cover_url = '' WHERE album_key = ? AND cover_url = ?").run(key, badUrl);
    db.prepare("UPDATE user_album_activity SET cover_url = '' WHERE album_key = ? AND cover_url = ?").run(key, badUrl);
    const exploreRows = matchingExploreCoverRows(title, artist, badUrl);
    clearExploreCoverMemory(exploreRows);
    db.prepare("UPDATE explore_album_covers SET cover_url = '' WHERE title = ? AND artist = ? AND cover_url = ?").run(
      title || '',
      artist || '',
      badUrl
    );
  }
}

function repairAlbumCoverReferences(title, artist, coverUrl, badCoverUrls = [], source = 'cover-repair') {
  const key = albumKey(title, artist);
  const safeCoverUrl = safeExternalImageUrl(coverUrl);
  if (!key || !safeCoverUrl) return '';
  saveCanonicalAlbumMetadata({ title, artist, coverUrl: safeCoverUrl }, source);
  const oldValues = uniqueBy(['', ...safeCoverUrlList(badCoverUrls)], (value) => value);
  for (const oldCoverUrl of oldValues) {
    db.prepare('UPDATE list_albums SET cover_url = ? WHERE album_key = ? AND cover_url = ?').run(safeCoverUrl, key, oldCoverUrl);
    db.prepare('UPDATE user_album_activity SET cover_url = ? WHERE album_key = ? AND cover_url = ?').run(safeCoverUrl, key, oldCoverUrl);
    const exploreRows = matchingExploreCoverRows(title, artist, oldCoverUrl);
    clearExploreCoverMemory(exploreRows);
    db.prepare('UPDATE explore_album_covers SET cover_url = ? WHERE title = ? AND artist = ? AND cover_url = ?').run(
      safeCoverUrl,
      title || '',
      artist || '',
      oldCoverUrl
    );
  }
  return safeCoverUrl;
}

function cachedAlbumMetadata(albumKeyValue) {
  return db
    .prepare('SELECT title, artist, cover_url FROM album_metadata_cache WHERE album_key = ?')
    .get(albumKeyValue);
}

function saveCanonicalAlbumMetadata(albumInput, source = '') {
  const title = clampText(albumInput?.title, 160);
  if (!title) return '';
  const artist = clampText(albumInput?.artist, 160);
  const key = albumKey(title, artist);
  if (!key) return '';
  const coverUrl = safeExternalImageUrl(albumInput?.coverUrl || albumInput?.cover_url);
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO album_metadata_cache (album_key, title, artist, cover_url, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(album_key) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       cover_url = CASE
         WHEN excluded.cover_url != '' THEN excluded.cover_url
         ELSE album_metadata_cache.cover_url
       END,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run(key, title, artist, coverUrl, clampText(source, 80), updatedAt);
  upsertAlbumHydrationStatus(
    { albumKey: key, title, artist },
    {
      metadataStatus: 'complete',
      coverStatus: coverUrl ? 'complete' : undefined,
      metadataUpdatedAt: updatedAt,
      coverUpdatedAt: coverUrl ? updatedAt : undefined,
      lastError: ''
    }
  );
  if (coverUrl) saveAlbumCover(title, artist, coverUrl, source);
  return key;
}

function cachedTracksForAlbumKey(albumKeyValue) {
  return db
    .prepare(
      `SELECT track_key AS trackKey, title, disc_number AS discNumber, position
       FROM album_track_cache
       WHERE album_key = ?
       ORDER BY disc_number, position, rowid, track_key`
    )
    .all(albumKeyValue);
}

function clientHydrationStatus(albumKeyValue, title = '', artist = '', { tracks = [], coverUrl = '' } = {}) {
  const key = clampText(albumKeyValue, 320);
  if (!key) {
    return {
      metadataStatus: 'missing',
      coverStatus: 'missing',
      trackStatus: 'missing',
      lastError: ''
    };
  }

  let row = albumHydrationStatus(key);
  if (!row) {
    upsertAlbumHydrationStatus({ albumKey: key, title, artist });
    row = albumHydrationStatus(key);
  }

  const updates = {};
  const safeCoverUrl = safeExternalImageUrl(coverUrl);
  if (tracks.length && row?.track_status !== 'complete') {
    updates.trackStatus = 'complete';
    updates.tracksUpdatedAt = nowIso();
  }
  if ((cachedLocalCover(key) || safeCoverUrl) && row?.cover_status !== 'complete') {
    updates.coverStatus = 'complete';
    updates.coverUpdatedAt = nowIso();
  }
  if (Object.keys(updates).length) {
    upsertAlbumHydrationStatus({ albumKey: key, title, artist }, updates);
    row = albumHydrationStatus(key);
  }

  return {
    metadataStatus: row?.metadata_status || 'missing',
    coverStatus: row?.cover_status || 'missing',
    trackStatus: row?.track_status || 'missing',
    metadataUpdatedAt: row?.metadata_updated_at || null,
    coverUpdatedAt: row?.cover_updated_at || null,
    tracksUpdatedAt: row?.tracks_updated_at || null,
    lastError: row?.last_error || ''
  };
}

function hydrationPendingFromStatus(status, tracks = []) {
  const active = new Set(['queued', 'hydrating']);
  return (
    active.has(status?.trackStatus) ||
    active.has(status?.coverStatus) ||
    (!tracks.length && !['complete', 'failed'].includes(status?.trackStatus || 'missing'))
  );
}

function copyCachedTracksToListAlbum(listAlbumId, albumKeyValue) {
  const cachedTracks = cachedTracksForAlbumKey(albumKeyValue);
  if (!cachedTracks.length) return 0;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM album_tracks WHERE list_album_id = ?').get(listAlbumId).count || 0;
  if (existing) return 0;
  const insertTrack = db.prepare(
    `INSERT INTO album_tracks (list_album_id, track_key, title, disc_number, position)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const track of cachedTracks) {
    insertTrack.run(listAlbumId, track.trackKey, track.title, track.discNumber || 1, track.position);
  }
  return cachedTracks.length;
}

function copyCachedTracksToListAlbums(albumKeyValue) {
  let copied = 0;
  const rows = db
    .prepare(
      `SELECT la.id
       FROM list_albums la
       LEFT JOIN album_tracks at ON at.list_album_id = la.id
       WHERE la.album_key = ?
       GROUP BY la.id
       HAVING COUNT(at.id) = 0`
    )
    .all(albumKeyValue);
  for (const row of rows) copied += copyCachedTracksToListAlbum(row.id, albumKeyValue);
  return copied;
}

function saveCanonicalAlbumTracks(albumInput, source = '') {
  const key = saveCanonicalAlbumMetadata(albumInput, source);
  if (!key) return;
  const tracks = sanitizeTracks(albumInput?.tracks);
  if (!tracks.length) return;
  transaction(() => {
    db.prepare('DELETE FROM album_track_cache WHERE album_key = ?').run(key);
    const insertTrack = db.prepare(
      `INSERT INTO album_track_cache (album_key, track_key, title, disc_number, position, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const updatedAt = nowIso();
    for (const track of tracks) {
      insertTrack.run(key, track.trackKey, track.title, track.discNumber || 1, track.position, updatedAt);
    }
    upsertAlbumHydrationStatus(
      { albumKey: key, title: albumInput?.title, artist: albumInput?.artist },
      { trackStatus: 'complete', tracksUpdatedAt: updatedAt, lastError: '' }
    );
  })();
  copyCachedTracksToListAlbums(key);
}

function providerIdFromAlbumInput(albumInput) {
  return clampText(albumInput?.providerId || albumInput?.provider_id || albumInput?.id, 220);
}

function sourceContextFromAlbumInput(albumInput, fallback = '') {
  return clampText(albumInput?.sourceContext || albumInput?.source_context || fallback, 240);
}

function queueCoverJobForAlbum(albumInput, { priority = 50, sourceContext = '', force = false } = {}) {
  const title = clampText(albumInput?.title, 160);
  if (!title) return null;
  const artist = clampText(albumInput?.artist, 160);
  const key = albumKey(title, artist);
  const coverUrl = safeExternalImageUrl(albumInput?.coverUrl || albumInput?.cover_url);
  if (coverUrl && !isLocalCoverPublicPath(coverUrl)) rememberCoverSource(key, coverUrl);
  if (force) clearAlbumCoverLookupFailure(key);
  if (cachedLocalCover(key) && !force) {
    upsertAlbumHydrationStatus({ albumKey: key, title, artist }, { coverStatus: 'complete', coverUpdatedAt: nowIso(), lastError: '' });
    return null;
  }
  if (!force && albumCoverLookupBackoff(key)) {
    upsertAlbumHydrationStatus({ albumKey: key, title, artist }, { coverStatus: 'failed' });
    return null;
  }
  const needsLocalRedownload = Boolean(!cachedLocalCover(key) && (coverSourceForAlbum(key) || (coverUrl && !isLocalCoverPublicPath(coverUrl))));
  const providerId = providerIdFromAlbumInput(albumInput);
  const context = sourceContextFromAlbumInput(albumInput, sourceContext);
  const jobKey = enqueueMetadataJob(
    {
      kind: context.startsWith('explore:') ? 'explore_cover' : 'cover',
      albumKey: key,
      title,
      artist,
      providerId,
      sourceContext: context,
      priority
    },
    { force: force || needsLocalRedownload }
  );
  const queuedStatus = jobKey ? db.prepare('SELECT status FROM metadata_jobs WHERE job_key = ?').get(jobKey)?.status : '';
  if (queuedStatus === 'queued' || queuedStatus === 'running') {
    upsertAlbumHydrationStatus({ albumKey: key, title, artist }, { coverStatus: queuedStatus === 'running' ? 'hydrating' : 'queued' });
  }
  return jobKey;
}

function queueAlbumHydrationJobs(albumInput, { priority = 20, sourceContext = '', forceCover = false } = {}) {
  const title = clampText(albumInput?.title, 160);
  if (!title) return [];
  const artist = clampText(albumInput?.artist, 160);
  const key = albumKey(title, artist);
  saveCanonicalAlbumMetadata(albumInput, sourceContext || 'metadata-queue');
  const providerId = providerIdFromAlbumInput(albumInput);
  const context = sourceContextFromAlbumInput(albumInput, sourceContext);
  const keys = [];
  keys.push(
    enqueueMetadataJob({
      kind: 'album_metadata',
      albumKey: key,
      title,
      artist,
      providerId,
      sourceContext: context,
      priority
    })
  );
  const hasCachedTracks = cachedTracksForAlbumKey(key).length > 0;
  keys.push(
    enqueueMetadataJob(
      {
        kind: 'tracklist',
        albumKey: key,
        title,
        artist,
        providerId,
        sourceContext: context,
        priority: priority + 5
      },
      { force: !hasCachedTracks }
    )
  );
  upsertAlbumHydrationStatus(
    { albumKey: key, title, artist },
    { trackStatus: hasCachedTracks ? 'complete' : 'queued' }
  );
  const coverJobKey = queueCoverJobForAlbum(albumInput, {
    priority: priority + 3,
    sourceContext: context,
    force: forceCover
  });
  if (coverJobKey) keys.push(coverJobKey);
  return keys;
}

function queueSearchResultHydrationJobs(results) {
  for (const album of (results || []).slice(0, 5)) {
    queueAlbumHydrationJobs(album, {
      priority: 65,
      sourceContext: 'search'
    });
  }
}

function queueExploreCoverJobsForList(list, { priority = 90, limit = 48 } = {}) {
  let queued = 0;
  for (const [index, album] of list.albums.entries()) {
    if (queued >= limit) break;
    const key = albumKey(album.title, album.artist);
    const coverUrl =
      safeExternalImageUrl(album.coverUrl) ||
      cachedExploreCover(list.slug, index) ||
      cachedAlbumCoverValue(album.title, album.artist);
    if (coverUrl && !isLocalCoverPublicPath(coverUrl)) rememberCoverSource(key, coverUrl);
    if (cachedLocalCover(key)) continue;
    const jobKey = queueCoverJobForAlbum(
      {
        ...album,
        providerId: album.spotifyId ? `spotify:${album.spotifyId}` : '',
        coverUrl,
        sourceContext: `explore:${list.slug}:${index}`
      },
      {
        priority,
        sourceContext: `explore:${list.slug}:${index}`
      }
    );
    if (jobKey) queued += 1;
  }
}

async function resolveVerifiedAlbumCover(title, artist, country = 'US', excludedUrls = []) {
  const excluded = new Set(excludedUrls.map(safeExternalImageUrl).filter(Boolean));
  const rejected = new Set(excluded);
  const tryCoverUrl = async (coverUrl, source) => {
    const safeCoverUrl = safeExternalImageUrl(coverUrl);
    if (!safeCoverUrl || excluded.has(safeCoverUrl) || rejected.has(safeCoverUrl)) return '';
    if (await imageUrlWorks(safeCoverUrl)) return saveAlbumCover(title, artist, safeCoverUrl, source);
    rejected.add(safeCoverUrl);
    return '';
  };
  for (const cached of storedAlbumCoverCandidates(title, artist)) {
    if (excluded.has(cached)) continue;
    if (await imageUrlWorks(cached)) {
      clearAlbumCoverLookupFailure(albumKey(title, artist));
      return saveAlbumCover(title, artist, cached, 'verified-cache');
    }
    rejected.add(cached);
  }
  if (rejected.size) clearBadAlbumCoverReferences(title, artist, [...rejected]);
  for (const album of await albumCoverCandidates(title, artist, country)) {
    for (const coverUrl of coverCandidatesForLookupAlbum(album)) {
      const verified = await tryCoverUrl(coverUrl, album.provider || 'metadata');
      if (verified) {
        clearAlbumCoverLookupFailure(albumKey(title, artist));
        return verified;
      }
    }
    if (String(album.providerId || '').startsWith('mb:')) {
      const lookup = await lookupAlbum(album.providerId, country).catch(() => null);
      for (const coverUrl of coverCandidatesForLookupAlbum(lookup)) {
        const verified = await tryCoverUrl(coverUrl, 'musicbrainz-catalog');
        if (verified) {
          clearAlbumCoverLookupFailure(albumKey(title, artist));
          return verified;
        }
      }
    }
  }
  if (rejected.size) clearBadAlbumCoverReferences(title, artist, [...rejected]);
  recordAlbumCoverLookupFailure(title, artist, 'metadata', 'No working cover found.');
  upsertAlbumHydrationStatus({ albumKey: albumKey(title, artist), title, artist }, { coverStatus: 'failed', lastError: 'No working cover found.' });
  return '';
}

function insertAlbum(listId, userId, albumInput) {
  const title = clampText(albumInput?.title, 160);
  if (!title) throw httpError(400, 'Album title is required.');

  const artist = clampText(albumInput?.artist, 160);
  const coverUrl = validateCoverUrl(albumInput?.coverUrl || albumInput?.cover_url);
  const notes = clampText(albumInput?.notes, 1200);
  const key = albumKey(title, artist);
  const inputTracks = sanitizeTracks(albumInput?.tracks);
  const tracks = inputTracks.length ? inputTracks : cachedTracksForAlbumKey(key);
  const existing = findAlbumInList(listId, title, artist);
  if (existing) {
    updateExistingAlbumFromInput(existing, { artist, coverUrl, tracks }, listId);
    queueAlbumHydrationJobs({ ...albumInput, title, artist, coverUrl }, { priority: 15, sourceContext: 'list-add' });
    return Number(existing.id);
  }
  const albumCount = db.prepare('SELECT COUNT(*) AS count FROM list_albums WHERE list_id = ?').get(listId).count || 0;
  if (albumCount >= maxAlbumsPerList) {
    throw httpError(400, `Lists are limited to ${maxAlbumsPerList} albums for the beta.`);
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM list_albums WHERE list_id = ?').get(listId)
    .max_order;

  const info = db
    .prepare(
      `INSERT INTO list_albums
       (list_id, album_key, title, artist, cover_url, notes, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(listId, key, title, artist, coverUrl, notes, maxOrder + 1, userId, nowIso(), nowIso());

  const insertTrack = db.prepare(
    `INSERT INTO album_tracks (list_album_id, track_key, title, disc_number, position)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const track of tracks) {
    insertTrack.run(info.lastInsertRowid, track.trackKey, track.title, track.discNumber || 1, track.position);
  }
  if (tracks.length) saveCanonicalAlbumTracks({ title, artist, coverUrl, tracks }, 'list-album');
  else saveCanonicalAlbumMetadata({ title, artist, coverUrl }, 'list-album');
  queueAlbumHydrationJobs({ ...albumInput, title, artist, coverUrl }, { priority: 15, sourceContext: 'list-add' });

  return Number(info.lastInsertRowid);
}

function replaceAlbumTracks(listAlbumId, tracks) {
  db.prepare('DELETE FROM album_tracks WHERE list_album_id = ?').run(listAlbumId);
  const insertTrack = db.prepare(
    `INSERT INTO album_tracks (list_album_id, track_key, title, disc_number, position)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const track of sanitizeTracks(tracks)) {
    insertTrack.run(listAlbumId, track.trackKey, track.title, track.discNumber || 1, track.position);
  }
}

function syncTrackRatingTitles(albumKeyValue, tracks) {
  const updateRatingTitle = db.prepare(
    `UPDATE track_ratings
     SET track_title = ?
     WHERE album_key = ? AND track_key = ?`
  );
  for (const track of tracks) {
    updateRatingTitle.run(track.title, albumKeyValue, track.trackKey);
  }
}

function existingTrackRows(listAlbumId) {
  return db
    .prepare('SELECT track_key, title, disc_number, position FROM album_tracks WHERE list_album_id = ? ORDER BY disc_number, position, id, track_key')
    .all(listAlbumId);
}

function isOrderedSubset(needles, haystack) {
  let index = 0;
  for (const item of haystack) {
    if (item === needles[index]) index += 1;
    if (index >= needles.length) return true;
  }
  return needles.length === 0;
}

function shouldReplaceTracks(existingTracks, nextTracks) {
  if (!nextTracks.length) return false;
  if (!existingTracks.length) return true;
  if (nextTracks.length === existingTracks.length) {
    return trackListJapaneseScore(nextTracks) > trackListJapaneseScore(existingTracks);
  }
  if (nextTracks.length < existingTracks.length) return false;
  const existingKeys = existingTracks.map((track, index) => track.track_key || trackKey(track.title, index + 1));
  const nextKeys = nextTracks.map((track) => track.trackKey);
  return isOrderedSubset(existingKeys, nextKeys);
}

function updateExistingAlbumFromInput(existing, albumInput, listId) {
  return transaction(() => {
    const artist = clampText(albumInput?.artist, 160);
    const coverUrl = validateCoverUrl(albumInput?.coverUrl || albumInput?.cover_url);
    const inputTracks =
      Array.isArray(albumInput?.tracks) && albumInput.tracks.every((track) => track?.trackKey)
        ? albumInput.tracks
        : sanitizeTracks(albumInput?.tracks);
    const tracks = inputTracks.length ? inputTracks : cachedTracksForAlbumKey(existing.album_key);
    let changed = false;

    if ((!existing.cover_url && coverUrl) || (!existing.artist && artist)) {
      db.prepare(
        `UPDATE list_albums
         SET artist = CASE WHEN artist = '' THEN ? ELSE artist END,
             cover_url = CASE WHEN cover_url = '' THEN ? ELSE cover_url END,
             updated_at = ?
         WHERE id = ?`
      ).run(artist, coverUrl, nowIso(), existing.id);
      changed = true;
    }

    if (shouldReplaceTracks(existingTrackRows(existing.id), tracks)) {
      replaceAlbumTracks(existing.id, tracks);
      syncTrackRatingTitles(existing.album_key, tracks);
      db.prepare('UPDATE list_albums SET updated_at = ? WHERE id = ?').run(nowIso(), existing.id);
      changed = true;
    }

    saveCanonicalAlbumTracks(
      {
        title: existing.title,
        artist: artist || existing.artist || '',
        coverUrl: coverUrl || safeExternalImageUrl(existing.cover_url),
        tracks
      },
      'list-album'
    );

    if (changed) {
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), listId);
    }
    return changed;
  })();
}

function existingTracksForAlbumKey(albumKeyValue) {
  const source = db
    .prepare(
      `SELECT la.id
       FROM list_albums la
       JOIN album_tracks at ON at.list_album_id = la.id
       WHERE la.album_key = ?
       GROUP BY la.id
       ORDER BY COUNT(at.id) DESC, MAX(la.updated_at) DESC, la.id DESC
       LIMIT 1`
    )
    .get(albumKeyValue);
  if (!source) return cachedTracksForAlbumKey(albumKeyValue);

  return db
    .prepare(
      `SELECT track_key AS trackKey, title, disc_number AS discNumber, position
       FROM album_tracks
       WHERE list_album_id = ?
       ORDER BY disc_number, position, id, track_key`
    )
    .all(source.id);
}

function albumMetadataMatchesInput(candidate, title, artist) {
  const candidateTitle = normalizeText(candidate?.title);
  const targetTitle = normalizeText(title);
  if (!candidateTitle || candidateTitle !== targetTitle) return false;
  const targetArtist = normalizeText(artist);
  if (!targetArtist) return true;
  const candidateArtist = normalizeText(candidate?.artist);
  if (!candidateArtist) return false;
  return candidateArtist === targetArtist || candidateArtist.includes(targetArtist) || targetArtist.includes(candidateArtist);
}

async function albumLookupCandidatesForInput(title, artist, country) {
  const queries = uniqueBy(
    [
      `${artist} ${title}`.trim(),
      `${title} ${artist}`.trim(),
      title
    ].filter((query) => query.length >= 2),
    (query) => normalizeText(query)
  );
  const settled = await Promise.allSettled(queries.map((query) => searchAlbums(query, country)));
  return uniqueBy(
    settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
    (album) => albumProviderSearchKey(album) || compactAlbumIdentity(album.title, album.artist)
  );
}

async function hydrateAlbumInputTracks(albumInput, req) {
  if (sanitizeTracks(albumInput?.tracks).length) return albumInput;

  const title = clampText(albumInput?.title, 160);
  if (!title) return albumInput;
  const artist = clampText(albumInput?.artist, 160);
  const key = albumKey(title, artist);
  const existingTracks = existingTracksForAlbumKey(key);
  if (existingTracks.length) return { ...albumInput, tracks: existingTracks };

  limitAlbumLookup(req);
  const country = itunesCountry(req);
  const candidates = await albumLookupCandidatesForInput(title, artist, country).catch(() => []);
  for (const candidate of candidates.slice(0, 5)) {
    if (!albumMetadataMatchesInput(candidate, title, artist)) continue;
    const lookup = await lookupAlbum(candidate.providerId, country).catch(() => null);
    const tracks = sanitizeTracks(lookup?.tracks);
    if (tracks.length) {
      return {
        ...albumInput,
        artist: albumInput?.artist || lookup.artist || '',
        coverUrl: albumInput?.coverUrl || albumInput?.cover_url || preferredCoverUrlForAlbum(lookup),
        tracks
      };
    }
  }

  return albumInput;
}

function findAlbumInList(listId, title, artist) {
  const key = albumKey(title, artist);
  const exact = db.prepare('SELECT * FROM list_albums WHERE list_id = ? AND album_key = ?').get(listId, key);
  if (exact) return exact;

  const compactKey = compactAlbumIdentity(title, artist);
  if (!compactKey) return null;
  return (
    db
      .prepare('SELECT * FROM list_albums WHERE list_id = ? ORDER BY sort_order, id')
      .all(listId)
      .find((album) => compactAlbumIdentity(album.title, album.artist) === compactKey) || null
  );
}

function removeListAlbum(list, user, album) {
  if (list.kind === 'collab') {
    const member = getMember(list.id, user.id);
    if (!member) throw httpError(403, 'Only list members can vote to remove albums.');
    db.prepare(
      `INSERT OR IGNORE INTO list_album_removal_votes (list_album_id, user_id, created_at)
       VALUES (?, ?, ?)`
    ).run(album.id, user.id, nowIso());
    const voteCount = db.prepare('SELECT COUNT(*) AS count FROM list_album_removal_votes WHERE list_album_id = ?').get(album.id).count || 0;
    const threshold = removalThreshold(list.id);
    if (voteCount >= threshold) {
      db.prepare('DELETE FROM list_albums WHERE id = ? AND list_id = ?').run(album.id, list.id);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), list.id);
      return { removed: true, voteCount, threshold, albumId: album.id };
    }
    return { removed: false, voteCount, threshold, albumId: album.id };
  }

  if (album.created_by !== user.id && list.owner_user_id !== user.id) assertCanEdit(list, user);
  db.prepare('DELETE FROM list_albums WHERE id = ? AND list_id = ?').run(album.id, list.id);
  db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), list.id);
  return { removed: true, voteCount: 1, threshold: 1, albumId: album.id };
}

function importGuestAlbums(userId, guestImport) {
  if (!guestImport || !Array.isArray(guestImport.albums)) return { imported: 0, listId: ensurePersonalList(userId) };
  const listId = ensurePersonalList(userId);
  const albums = guestImport.albums.slice(0, 200);
  let imported = 0;

  const tx = transaction(() => {
    for (const album of albums) {
      if (!clampText(album?.title, 160)) continue;
      const albumId = insertAlbum(listId, userId, album);
      if (album.completed) {
        db.prepare(
          `INSERT OR IGNORE INTO album_completions (list_album_id, user_id, completed_at)
           VALUES (?, ?, ?)`
        ).run(albumId, userId, nowIso());
        const savedAlbum = db.prepare('SELECT * FROM list_albums WHERE id = ?').get(albumId);
        upsertUserAlbumActivity(userId, savedAlbum, { completedAt: nowIso() });
      }
      imported += 1;
    }
    db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), listId);
  });
  tx();

  return { imported, listId };
}

function albumRatingAggregate(albumKeyValue, trackKeyValue = null) {
  const whereTrack = trackKeyValue ? 'AND r.track_key = ?' : '';
  const params = trackKeyValue ? [albumKeyValue, trackKeyValue] : [albumKeyValue];
  const row = db
    .prepare(
      `SELECT AVG(r.rating) AS average_rating, COUNT(*) AS rating_count
       FROM track_ratings r
       LEFT JOIN album_average_opt_in opt
         ON opt.user_id = r.user_id AND opt.album_key = r.album_key
       WHERE r.album_key = ?
         ${whereTrack}
         AND r.include_in_average = 1
         AND COALESCE(opt.include_in_average, 1) = 1`
    )
    .get(...params);

  return {
    average: row.average_rating === null ? null : Math.round(row.average_rating * 10) / 10,
    count: row.rating_count || 0
  };
}

function sharedListRatingAggregate(listId, albumKeyValue, trackKeyValue = null) {
  const whereTrack = trackKeyValue ? 'AND r.track_key = ?' : '';
  const params = trackKeyValue ? [listId, albumKeyValue, trackKeyValue] : [listId, albumKeyValue];
  const row = db
    .prepare(
      `SELECT AVG(r.rating) AS average_rating, COUNT(*) AS rating_count
       FROM track_ratings r
       JOIN list_members rating_member
         ON rating_member.list_id = ? AND rating_member.user_id = r.user_id
       LEFT JOIN album_average_opt_in opt
         ON opt.user_id = r.user_id AND opt.album_key = r.album_key
       WHERE r.album_key = ?
         ${whereTrack}
         AND r.include_in_average = 1
         AND COALESCE(opt.include_in_average, 1) = 1`
    )
    .get(...params);

  return {
    average: row.average_rating === null ? null : Math.round(row.average_rating * 10) / 10,
    count: row.rating_count || 0
  };
}

function userAlbumAverage(userId, albumKeyValue) {
  const row = db
    .prepare(
      `SELECT AVG(rating) AS average_rating, COUNT(*) AS rating_count
       FROM track_ratings
       WHERE user_id = ? AND album_key = ? AND include_in_average = 1`
    )
    .get(userId, albumKeyValue);
  return {
    average: row.average_rating === null ? null : Math.round(row.average_rating * 10) / 10,
    count: row.rating_count || 0
  };
}

function userAlbumFullyListened(userId, albumKeyValue, knownCompletedAt = null) {
  if (knownCompletedAt) return true;

  const activity = db
    .prepare('SELECT completed_at FROM user_album_activity WHERE user_id = ? AND album_key = ?')
    .get(userId, albumKeyValue);
  if (activity?.completed_at) return true;

  const fullyRatedKnownTrackList = db
    .prepare(
      `SELECT 1
       FROM list_albums la
       JOIN album_tracks at ON at.list_album_id = la.id
       LEFT JOIN track_ratings tr
         ON tr.user_id = ?
        AND tr.album_key = la.album_key
        AND tr.track_key = at.track_key
       WHERE la.album_key = ?
       GROUP BY la.id
       HAVING COUNT(at.id) > 0 AND COUNT(DISTINCT tr.track_key) >= COUNT(at.id)
       LIMIT 1`
    )
    .get(userId, albumKeyValue);
  if (fullyRatedKnownTrackList) return true;

  const knownTrackCount = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM album_tracks at
       JOIN list_albums la ON la.id = at.list_album_id
       WHERE la.album_key = ?`
    )
    .get(albumKeyValue).count;
  if (knownTrackCount > 0) return false;

  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM track_ratings
         WHERE user_id = ? AND album_key = ? AND track_key = ?
         LIMIT 1`
      )
      .get(userId, albumKeyValue, albumLevelTrackKey)
  );
}

function userAlbumFullyRated(userId, albumKeyValue, listAlbumId = null) {
  const trackCount = listAlbumId
    ? db.prepare('SELECT COUNT(*) AS count FROM album_tracks WHERE list_album_id = ?').get(listAlbumId).count
    : db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM album_tracks at
           JOIN list_albums la ON la.id = at.list_album_id
           WHERE la.album_key = ?`
        )
        .get(albumKeyValue).count;

  if (trackCount > 0) {
    const ratedCount = listAlbumId
      ? db
          .prepare(
            `SELECT COUNT(DISTINCT at.track_key) AS count
             FROM album_tracks at
             JOIN track_ratings tr
               ON tr.user_id = ?
              AND tr.album_key = ?
              AND tr.track_key = at.track_key
             WHERE at.list_album_id = ?`
          )
          .get(userId, albumKeyValue, listAlbumId).count
      : db
          .prepare(
            `SELECT COUNT(DISTINCT tr.track_key) AS count
             FROM track_ratings tr
             WHERE tr.user_id = ?
               AND tr.album_key = ?
               AND tr.track_key != ?`
          )
          .get(userId, albumKeyValue, albumLevelTrackKey).count;
    return ratedCount >= trackCount;
  }

  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM track_ratings
         WHERE user_id = ? AND album_key = ? AND track_key = ?
         LIMIT 1`
      )
      .get(userId, albumKeyValue, albumLevelTrackKey)
  );
}

function upsertUserAlbumActivity(userId, album, values = {}) {
  const completedAt = values.completedAt === undefined ? null : values.completedAt;
  const ratedAt = values.ratedAt === undefined ? null : values.ratedAt;
  db.prepare(
    `INSERT INTO user_album_activity
     (user_id, album_key, title, artist, cover_url, completed_at, rated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, album_key) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       cover_url = excluded.cover_url,
       completed_at = COALESCE(excluded.completed_at, user_album_activity.completed_at),
       rated_at = COALESCE(excluded.rated_at, user_album_activity.rated_at),
       updated_at = excluded.updated_at`
  ).run(
    userId,
    album.album_key,
    album.title,
    album.artist || '',
    safeExternalImageUrl(album.cover_url),
    completedAt,
    ratedAt,
    nowIso()
  );
}

function listAlbumCompletions(listId, listAlbumId, albumKeyValue) {
  const rows = db
    .prepare(
      `SELECT ac.completed_at, u.id AS user_id, u.username, u.avatar_color, u.avatar_data_url
       FROM album_completions ac
       JOIN users u ON u.id = ac.user_id
       WHERE ac.list_album_id = ?
       UNION ALL
       SELECT activity.completed_at, u.id AS user_id, u.username, u.avatar_color, u.avatar_data_url
       FROM user_album_activity activity
       JOIN list_members lm ON lm.list_id = ? AND lm.user_id = activity.user_id
       JOIN users u ON u.id = activity.user_id
       WHERE activity.album_key = ? AND activity.completed_at IS NOT NULL`
    )
    .all(listAlbumId, listId, albumKeyValue);

  const byUserId = new Map();
  for (const row of rows) {
    const existing = byUserId.get(row.user_id);
    if (!existing || String(row.completed_at) > String(existing.completedAt)) {
      byUserId.set(row.user_id, {
        userId: row.user_id,
        username: row.username,
        avatarColor: row.avatar_color,
        avatarUrl: safeAvatarDataUrl(row.avatar_data_url),
        completedAt: row.completed_at
      });
    }
  }

  return [...byUserId.values()].sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
}

function maybeAutoCompleteAlbum(list, album, userId) {
  const trackCount = db.prepare('SELECT COUNT(*) AS count FROM album_tracks WHERE list_album_id = ?').get(album.id).count;
  if (!trackCount) return false;
  const ratedCount = db
    .prepare(
      `SELECT COUNT(DISTINCT at.track_key) AS count
       FROM album_tracks at
       JOIN track_ratings tr
         ON tr.album_key = ? AND tr.track_key = at.track_key AND tr.user_id = ?
       WHERE at.list_album_id = ?`
    )
    .get(album.album_key, userId, album.id).count;
  if (ratedCount < trackCount) return false;

  db.prepare(
    `INSERT INTO album_completions (list_album_id, user_id, completed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(list_album_id, user_id) DO UPDATE SET completed_at = COALESCE(album_completions.completed_at, excluded.completed_at)`
  ).run(album.id, userId, nowIso());
  upsertUserAlbumActivity(userId, album, { completedAt: nowIso(), ratedAt: nowIso() });
  return true;
}

function removalThreshold(listId) {
  const memberCount = db.prepare('SELECT COUNT(*) AS count FROM list_members WHERE list_id = ?').get(listId).count || 1;
  return Math.max(1, Math.ceil(memberCount / 4));
}

function listChatMessages(listId) {
  return db
    .prepare(
      `SELECT lm.id, lm.body, lm.created_at, u.id AS user_id, u.username, u.avatar_color, u.avatar_data_url
       FROM list_messages lm
       JOIN users u ON u.id = lm.user_id
       WHERE lm.list_id = ?
       ORDER BY lm.created_at DESC
       LIMIT 100`
    )
    .all(listId)
    .reverse()
    .map((message) => ({
      id: message.id,
      body: message.body,
      createdAt: message.created_at,
      userId: message.user_id,
      username: message.username,
      avatarColor: message.avatar_color,
      avatarUrl: safeAvatarDataUrl(message.avatar_data_url)
    }));
}

function listRevision(listId) {
  const row = db
    .prepare(
      `SELECT
         l.updated_at AS list_updated_at,
         (SELECT MAX(updated_at) FROM list_albums WHERE list_id = l.id) AS albums_updated_at,
         (SELECT MAX(r.updated_at)
          FROM track_ratings r
          JOIN list_albums la ON la.album_key = r.album_key
          WHERE la.list_id = l.id) AS ratings_updated_at,
         (SELECT MAX(opt.updated_at)
          FROM album_average_opt_in opt
          JOIN list_albums la ON la.album_key = opt.album_key
          WHERE la.list_id = l.id) AS rating_prefs_updated_at,
         (SELECT MAX(completed_at)
          FROM album_completions ac
          JOIN list_albums la ON la.id = ac.list_album_id
          WHERE la.list_id = l.id) AS completions_updated_at,
         (SELECT MAX(activity.updated_at)
          FROM user_album_activity activity
          JOIN list_albums la ON la.album_key = activity.album_key
          WHERE la.list_id = l.id) AS activity_updated_at,
         (SELECT MAX(votes.created_at)
          FROM list_album_removal_votes votes
          JOIN list_albums la ON la.id = votes.list_album_id
          WHERE la.list_id = l.id) AS votes_updated_at,
         (SELECT MAX(created_at) FROM list_messages WHERE list_id = l.id) AS messages_updated_at,
         (SELECT MAX(joined_at) FROM list_members WHERE list_id = l.id) AS members_updated_at,
         (SELECT COUNT(*) FROM list_members WHERE list_id = l.id) AS member_count,
         (SELECT COUNT(*) FROM list_albums WHERE list_id = l.id) AS album_count
       FROM lists l
       WHERE l.id = ?`
    )
    .get(listId);
  if (!row) return '';
  return [
    row.list_updated_at,
    row.albums_updated_at,
    row.ratings_updated_at,
    row.rating_prefs_updated_at,
    row.completions_updated_at,
    row.activity_updated_at,
    row.votes_updated_at,
    row.messages_updated_at,
    row.members_updated_at,
    row.member_count,
    row.album_count
  ]
    .map((value) => value ?? '')
    .join('|');
}

function buildListAccess(list, user, allowShare = false) {
  const member = assertCanView(list, user, allowShare);
  const members = listMembers(list.id);
  return {
    allowShare,
    member,
    members,
    canEdit: Boolean(member && ['owner', 'editor'].includes(member.role)),
    canManage: Boolean(member && member.role === 'owner'),
    canRate: Boolean(member && user),
    isMember: Boolean(member)
  };
}

function buildListSummaryPayload(list, access, albumCount) {
  const resolvedAlbumCount =
    albumCount ??
    (db.prepare('SELECT COUNT(*) AS count FROM list_albums WHERE list_id = ?').get(list.id).count || 0);
  return formatListSummary(
    {
      ...list,
      role: access.member?.role || null,
      owner_username: db.prepare('SELECT username FROM users WHERE id = ?').get(list.owner_user_id)?.username,
      album_count: resolvedAlbumCount,
      member_count: access.members.length
    },
    {
      includeShareToken: access.canManage || access.allowShare,
      includeInviteToken: access.canManage
    }
  );
}

function canSeeNamedRatings(list, user, access) {
  return Boolean(user && list.show_ratings && list.kind === 'collab' && access.isMember);
}

function buildListAlbumPayload(list, user, album, access) {
  const personalAlbum =
    user && list.kind !== 'personal'
      ? db
          .prepare(
            `SELECT la.id, la.list_id
             FROM list_albums la
             JOIN lists l ON l.id = la.list_id
             WHERE l.owner_user_id = ? AND l.kind = 'personal' AND la.album_key = ?
             LIMIT 1`
          )
          .get(user.id, album.album_key)
      : null;
  const personalAverage = user ? userAlbumAverage(user.id, album.album_key) : null;
  const currentUserAggregate = user ? userAlbumAverage(user.id, album.album_key) : null;
  const showNamedRatings = canSeeNamedRatings(list, user, access);
  const tracks = db
    .prepare('SELECT * FROM album_tracks WHERE list_album_id = ? ORDER BY disc_number, position, id, track_key')
    .all(album.id)
    .map((track) => {
      const userRating = user
        ? db
            .prepare(
              `SELECT rating, include_in_average, updated_at
               FROM track_ratings
               WHERE user_id = ? AND album_key = ? AND track_key = ?`
            )
            .get(user.id, album.album_key, track.track_key)
        : null;

      return {
        id: track.id,
        title: track.title,
        discNumber: track.disc_number || 1,
        position: track.position,
        trackKey: track.track_key,
        userRating: userRating
          ? {
              rating: userRating.rating,
              includeInAverage: Boolean(userRating.include_in_average),
              updatedAt: userRating.updated_at
            }
          : null,
        aggregate: list.show_ratings ? albumRatingAggregate(album.album_key, track.track_key) : null,
        sharedAggregate: showNamedRatings ? sharedListRatingAggregate(list.id, album.album_key, track.track_key) : null
      };
    });

  const completions = listAlbumCompletions(list.id, album.id, album.album_key);
  const completedIds = new Set(completions.map((completion) => completion.userId));
  const pendingMembers = access.members.filter((listMember) => !completedIds.has(listMember.userId));
  const removalVoteCount = db.prepare('SELECT COUNT(*) AS count FROM list_album_removal_votes WHERE list_album_id = ?').get(album.id).count || 0;
  const removalVoteThreshold = list.kind === 'collab' ? removalThreshold(list.id) : 1;
  const currentUserRemovalVoted = user
    ? Boolean(
        db
          .prepare('SELECT 1 FROM list_album_removal_votes WHERE list_album_id = ? AND user_id = ?')
          .get(album.id, user.id)
      )
    : false;
  const optInRow = user
    ? db
        .prepare('SELECT include_in_average FROM album_average_opt_in WHERE user_id = ? AND album_key = ?')
        .get(user.id, album.album_key)
    : null;
  const albumLevelRating = user
    ? db
        .prepare(
          `SELECT rating, include_in_average, updated_at
           FROM track_ratings
           WHERE user_id = ? AND album_key = ? AND track_key = ?`
        )
        .get(user.id, album.album_key, albumLevelTrackKey)
    : null;

  const displayCoverUrl = safeExternalImageUrl(album.cover_url);
  let hydrationStatus = clientHydrationStatus(album.album_key, album.title, album.artist, {
    tracks,
    coverUrl: displayCoverUrl
  });
  if (!tracks.length) {
    queueAlbumHydrationJobs(
      { title: album.title, artist: album.artist, coverUrl: displayCoverUrl, sourceContext: 'list-view' },
      { priority: 45, sourceContext: 'list-view' }
    );
  } else if (displayCoverUrl && !isLocalCoverPublicPath(displayCoverUrl) && !cachedLocalCover(album.album_key)) {
    queueCoverJobForAlbum(
      { title: album.title, artist: album.artist, coverUrl: displayCoverUrl, sourceContext: 'list-view' },
      { priority: 55, sourceContext: 'list-view' }
    );
  }
  hydrationStatus = clientHydrationStatus(album.album_key, album.title, album.artist, {
    tracks,
    coverUrl: displayCoverUrl
  });

  const ratingsByUser =
    showNamedRatings
      ? db
          .prepare(
            `SELECT r.user_id, u.username, u.avatar_color, u.avatar_data_url, r.track_key, r.track_title, r.rating, r.include_in_average, r.updated_at
             FROM track_ratings r
             JOIN list_members rating_member ON rating_member.list_id = ? AND rating_member.user_id = r.user_id
             JOIN users u ON u.id = r.user_id
             WHERE r.album_key = ?
               AND r.user_id != ?
             ORDER BY u.username COLLATE NOCASE, r.track_title COLLATE NOCASE`
          )
          .all(list.id, album.album_key, user.id)
          .map((rating) => ({
            userId: rating.user_id,
            username: rating.username,
            avatarColor: rating.avatar_color,
            avatarUrl: safeAvatarDataUrl(rating.avatar_data_url),
            trackKey: rating.track_key,
            trackTitle: rating.track_title,
            rating: rating.rating,
            includeInAverage: Boolean(rating.include_in_average),
            updatedAt: rating.updated_at
          }))
      : [];

  return {
    id: album.id,
    albumKey: album.album_key,
    title: album.title,
    artist: album.artist,
    coverUrl: displayCoverUrl,
    externalUrl: albumExternalUrl(album, user?.musicPlatform || 'na'),
    notes: album.notes,
    sortOrder: album.sort_order,
    createdBy: album.created_by,
    creatorUsername: album.creator_username,
    createdAt: album.created_at,
    updatedAt: album.updated_at,
    tracks,
    hydrationStatus,
    hydrationPending: hydrationPendingFromStatus(hydrationStatus, tracks),
    completions,
    pendingMembers,
    currentUserCompleted: Boolean(user && completedIds.has(user.id)),
    currentUserFullyRated: Boolean(user && userAlbumFullyRated(user.id, album.album_key, album.id)),
    currentUserAverageOptIn: optInRow ? Boolean(optInRow.include_in_average) : true,
    currentUserAlbumRating: albumLevelRating
      ? {
          rating: albumLevelRating.rating,
          includeInAverage: Boolean(albumLevelRating.include_in_average),
          updatedAt: albumLevelRating.updated_at
        }
      : null,
    currentUserAggregate,
    currentUserRemovalVoted,
    removalVoteCount,
    removalVoteThreshold,
    currentUserLibrary: personalAlbum
      ? {
          listId: personalAlbum.list_id,
          albumId: personalAlbum.id,
          average: personalAverage.average,
          ratingCount: personalAverage.count
        }
      : null,
    aggregate: list.show_ratings ? albumRatingAggregate(album.album_key) : null,
    sharedAggregate: showNamedRatings ? sharedListRatingAggregate(list.id, album.album_key) : null,
    ratingsByUser
  };
}

function buildListMutationResponse(list, user, options = {}) {
  const access = buildListAccess(list, user, options.allowShare);
  const response = { ok: true, revision: listRevision(list.id) };

  if (options.includeListSummary) {
    response.list = buildListSummaryPayload(list, access, options.albumCount);
  }

  if (options.albumId !== undefined && options.albumId !== null) {
    const album = db
      .prepare(
        `SELECT la.*, creator.username AS creator_username
         FROM list_albums la
         LEFT JOIN users creator ON creator.id = la.created_by
         WHERE la.id = ? AND la.list_id = ?`
      )
      .get(Number(options.albumId), list.id);
    if (album) response.album = buildListAlbumPayload(list, user, album, access);
  }

  if (options.removedAlbumId !== undefined && options.removedAlbumId !== null) {
    response.removedAlbumId = Number(options.removedAlbumId);
  }

  if (options.includeMessages && list.kind === 'collab' && access.member) {
    response.messages = listChatMessages(list.id);
  }

  return response;
}

function buildListPayload(list, user, allowShare = false) {
  const access = buildListAccess(list, user, allowShare);

  const albumRows = db
    .prepare(
      `SELECT la.*, creator.username AS creator_username
       FROM list_albums la
       LEFT JOIN users creator ON creator.id = la.created_by
       WHERE la.list_id = ?
       ORDER BY la.sort_order, la.created_at`
    )
    .all(list.id);

  const albums = albumRows.map((album) => buildListAlbumPayload(list, user, album, access));

  return {
    revision: listRevision(list.id),
    list: buildListSummaryPayload(list, access, albums.length),
    permissions: { canEdit: access.canEdit, canManage: access.canManage, canRate: access.canRate, isMember: access.isMember },
    members: access.members,
    albums,
    messages: list.kind === 'collab' && access.member ? listChatMessages(list.id) : []
  };
}

function sendListPayload(req, res, list, user, allowShare = false) {
  const revision = listRevision(list.id);
  if (req.query?.revision && String(req.query.revision) === revision) {
    res.json({ notModified: true, revision });
    return;
  }
  res.json(buildListPayload(list, user, allowShare));
}

function buildUserProfile(username, viewer) {
  const normalized = normalizeText(username);
  const profileUser = db.prepare('SELECT * FROM users WHERE username_normalized = ?').get(normalized);
  if (!profileUser) throw httpError(404, 'User not found.');

  const lists = db
    .prepare(
      `SELECT l.*,
        'owner' AS role,
        owner.username AS owner_username,
        COUNT(DISTINCT la.id) AS album_count,
        COUNT(DISTINCT members.user_id) AS member_count
       FROM lists l
       JOIN users owner ON owner.id = l.owner_user_id
       LEFT JOIN list_albums la ON la.list_id = l.id
       LEFT JOIN list_members members ON members.list_id = l.id
       WHERE l.owner_user_id = ?
         AND (l.visibility = 'public' OR ? = l.owner_user_id)
       GROUP BY l.id
       ORDER BY l.updated_at DESC`
    )
    .all(profileUser.id, viewer?.id || 0)
    .map(formatListSummary);

  const commonAlbumKeys = viewer
    ? new Set(
        db
          .prepare(
            `SELECT album_key FROM user_album_activity WHERE user_id = ?
             UNION
             SELECT album_key FROM track_ratings WHERE user_id = ?
             UNION
             SELECT la.album_key
             FROM list_albums la
             JOIN list_members lm ON lm.list_id = la.list_id
             WHERE lm.user_id = ?`
          )
          .all(viewer.id, viewer.id, viewer.id)
          .map((row) => row.album_key)
      )
    : new Set();

  const ratedAlbums = db
    .prepare(
      `WITH rated_keys AS (
         SELECT DISTINCT album_key FROM track_ratings WHERE user_id = ?
         UNION
         SELECT album_key
         FROM user_album_activity
         WHERE user_id = ?
           AND (rated_at IS NOT NULL OR completed_at IS NOT NULL)
       )
       SELECT
         rated_keys.album_key,
         COALESCE(NULLIF(activity.title, ''), MAX(la.title), rated_keys.album_key) AS title,
         COALESCE(NULLIF(activity.artist, ''), MAX(la.artist), '') AS artist,
         COALESCE(NULLIF(activity.cover_url, ''), MAX(la.cover_url), '') AS cover_url,
         activity.completed_at,
         activity.rated_at
       FROM rated_keys
       LEFT JOIN user_album_activity activity
         ON activity.user_id = ? AND activity.album_key = rated_keys.album_key
       LEFT JOIN list_albums la ON la.album_key = rated_keys.album_key
       GROUP BY rated_keys.album_key
       LIMIT 200`
    )
    .all(profileUser.id, profileUser.id, profileUser.id)
    .map((album) => {
      const average = userAlbumAverage(profileUser.id, album.album_key);
      const fullyListened = userAlbumFullyListened(profileUser.id, album.album_key, album.completed_at);
      const ratings = db
        .prepare(
          `WITH track_order AS (
             SELECT at.track_key,
                    MIN(at.disc_number) AS disc_number,
                    MIN(at.position) AS position,
                    MIN(at.id) AS stable_id
             FROM album_tracks at
             JOIN list_albums la ON la.id = at.list_album_id
             WHERE la.album_key = ?
             GROUP BY at.track_key
           )
           SELECT r.track_key, r.track_title, r.rating, r.include_in_average, r.updated_at
           FROM track_ratings r
           LEFT JOIN track_order ord ON ord.track_key = r.track_key
           WHERE r.user_id = ? AND r.album_key = ?
           ORDER BY r.track_key = ? DESC,
                    COALESCE(ord.disc_number, 999),
                    COALESCE(ord.position, 9999),
                    COALESCE(ord.stable_id, r.id),
                    r.track_title COLLATE NOCASE,
                    r.track_key`
        )
        .all(album.album_key, profileUser.id, album.album_key, albumLevelTrackKey)
        .map((rating) => ({
          trackKey: rating.track_key,
          trackTitle: rating.track_title,
          rating: rating.rating,
          includeInAverage: Boolean(rating.include_in_average),
          updatedAt: rating.updated_at
        }));
      return {
        albumKey: album.album_key,
        title: album.title,
        artist: album.artist,
        coverUrl: safeExternalImageUrl(album.cover_url),
        completedAt: album.completed_at,
        ratedAt: album.rated_at,
        fullyListened,
        average: average.average,
        ratingCount: average.count,
        ratings,
        inCommon: commonAlbumKeys.has(album.album_key)
      };
    })
    .sort((a, b) => {
      if (a.fullyListened !== b.fullyListened) return a.fullyListened ? -1 : 1;
      if (a.inCommon !== b.inCommon) return a.inCommon ? -1 : 1;
      return (b.average ?? -1) - (a.average ?? -1);
    });

  return {
    user: publicUser(profileUser, { includePrivate: viewer?.id === profileUser.id }),
    lists,
    ratedAlbums
  };
}

function exploreListBySlug(slug) {
  return allExploreLists({ includeHidden: true }).find((item) => item.slug === slug);
}

function exploreAlbumSourceByKey(albumKeyValue) {
  for (const list of allExploreLists({ includeHidden: true })) {
    const index = list.albums.findIndex((album) => albumKey(album.title, album.artist) === albumKeyValue);
    if (index >= 0) return { list, album: list.albums[index], index };
  }
  return null;
}

function visibleExploreLists() {
  return allExploreLists().filter((list) => !hiddenExploreSlugs.has(list.slug));
}

function dynamicExploreLists({ includeHidden = false } = {}) {
  const filters = includeHidden ? '' : 'WHERE ep.visible = 1';
  const playlists = db
    .prepare(
      `SELECT ep.*
       FROM explore_playlists ep
       ${filters}
       ORDER BY ep.sort_order ASC, ep.name COLLATE NOCASE ASC, ep.id ASC`
    )
    .all();
  const albumRows = db.prepare(
    `SELECT title, artist, cover_url, release_year
     FROM explore_playlist_albums
     WHERE playlist_id = ?
     ORDER BY sort_order ASC, id ASC`
  );

  return playlists.map((playlist) => {
    const albums = albumRows.all(playlist.id).map((album) => ({
      title: album.title,
      artist: album.artist || '',
      releaseYear: album.release_year ?? null,
      spotifyId: '',
      coverUrl: safeExternalImageUrl(album.cover_url)
    }));
    return {
      slug: playlist.slug,
      name: playlist.name,
      description: playlist.description || '',
      sourceUrl: playlist.share_link || '',
      albumCount: albums.length,
      dynamic: true,
      playlistId: playlist.id,
      albums
    };
  });
}

function allExploreLists({ includeHidden = false } = {}) {
  const staticLists = includeHidden ? staticExploreLists : staticExploreLists.filter((list) => !hiddenExploreSlugs.has(list.slug));
  return [...staticLists, ...dynamicExploreLists({ includeHidden })];
}

function exploreAlbumStatuses(user) {
  if (!user) return new Map();
  const statuses = new Map();
  for (const row of db
    .prepare(
      `SELECT album_key
       FROM user_album_activity
       WHERE user_id = ? AND completed_at IS NOT NULL
       UNION
       SELECT la.album_key
       FROM album_completions ac
       JOIN list_albums la ON la.id = ac.list_album_id
       WHERE ac.user_id = ?`
    )
    .all(user.id, user.id)) {
    statuses.set(row.album_key, { completed: true, average: null, ratingCount: 0 });
  }

  for (const row of db
    .prepare(
      `SELECT album_key, ROUND(AVG(rating), 1) AS average, COUNT(*) AS rating_count
       FROM track_ratings
       WHERE user_id = ? AND include_in_average = 1
       GROUP BY album_key`
    )
    .all(user.id)) {
    const current = statuses.get(row.album_key) || { completed: false, average: null, ratingCount: 0 };
    current.average = row.average === null || row.average === undefined ? null : Number(row.average);
    current.ratingCount = row.rating_count || 0;
    statuses.set(row.album_key, current);
  }

  for (const row of db
    .prepare(
      `SELECT album_key, rating, include_in_average, updated_at
       FROM track_ratings
       WHERE user_id = ? AND track_key = ?`
    )
    .all(user.id, albumLevelTrackKey)) {
    const current = statuses.get(row.album_key) || { completed: false, average: null, ratingCount: 0 };
    current.albumRating = {
      rating: row.rating,
      includeInAverage: Boolean(row.include_in_average),
      updatedAt: row.updated_at
    };
    statuses.set(row.album_key, current);
  }

  return statuses;
}

function canonicalCoverMapForAlbumKeys(albumKeys) {
  const covers = new Map();
  const uniqueKeys = [...new Set(albumKeys.filter(Boolean))];
  for (let index = 0; index < uniqueKeys.length; index += 500) {
    const chunk = uniqueKeys.slice(index, index + 500);
    const placeholders = chunk.map(() => '?').join(',');
    for (const row of db
      .prepare(`SELECT album_key, public_path AS cover_url FROM album_image_cache WHERE album_key IN (${placeholders}) AND public_path != ''`)
      .all(...chunk)) {
      const coverUrl = safeExternalImageUrl(row.cover_url);
      if (coverUrl && localCoverExists(coverUrl)) covers.set(row.album_key, coverUrl);
    }
    for (const row of db
      .prepare(`SELECT album_key, cover_url FROM album_cover_cache WHERE album_key IN (${placeholders})`)
      .all(...chunk)) {
      const coverUrl = safeExternalImageUrl(row.cover_url);
      if (coverUrl && !covers.has(row.album_key)) covers.set(row.album_key, coverUrl);
    }
    for (const row of db
      .prepare(`SELECT album_key, cover_url FROM album_metadata_cache WHERE album_key IN (${placeholders})`)
      .all(...chunk)) {
      const coverUrl = safeExternalImageUrl(row.cover_url);
      if (coverUrl && !covers.has(row.album_key)) covers.set(row.album_key, coverUrl);
    }
  }
  return covers;
}

function exploreAlbumPayload(album, index, statuses, cachedCovers, canonicalCovers) {
  const key = albumKey(album.title, album.artist);
  const status = statuses.get(key);
  return {
    ...album,
    albumKey: key,
    coverUrl:
      safeExternalImageUrl(album.coverUrl) ||
      safeExternalImageUrl(cachedCovers.get(index)) ||
      safeExternalImageUrl(canonicalCovers.get(key)) ||
      '',
    currentUserCompleted: Boolean(status?.completed),
    currentUserAlbumRating: status?.albumRating ?? null,
    currentUserRatingAverage: status?.average ?? null,
    currentUserRatingCount: status?.ratingCount ?? 0
  };
}

function persistKnownExploreCovers(list, cachedCovers, canonicalCovers) {
  for (const [index, album] of list.albums.entries()) {
    const key = albumKey(album.title, album.artist);
    const coverUrl =
      safeExternalImageUrl(album.coverUrl) ||
      safeExternalImageUrl(cachedCovers.get(index)) ||
      safeExternalImageUrl(canonicalCovers.get(key));
    if (coverUrl && coverUrl !== safeExternalImageUrl(cachedCovers.get(index))) {
      saveExploreCover(list.slug, index, album, coverUrl);
      cachedCovers.set(index, coverUrl);
    }
  }
}

function exploreListWithCachedCovers(list, user = null) {
  const cached = new Map(
    db
      .prepare('SELECT album_index, cover_url FROM explore_album_covers WHERE slug = ?')
      .all(list.slug)
      .map((row) => [row.album_index, safeExternalImageUrl(row.cover_url)])
  );
  const statuses = exploreAlbumStatuses(user);
  const canonicalCovers = canonicalCoverMapForAlbumKeys(list.albums.map((album) => albumKey(album.title, album.artist)));
  persistKnownExploreCovers(list, cached, canonicalCovers);
  return {
    ...list,
    albums: list.albums.map((album, index) => exploreAlbumPayload(album, index, statuses, cached, canonicalCovers))
  };
}

function cachedExploreCover(slug, albumIndex) {
  const memoryKey = `${slug}:${albumIndex}`;
  if (exploreCoverMemoryCache.has(memoryKey)) return exploreCoverMemoryCache.get(memoryKey);
  const row = db
    .prepare('SELECT cover_url FROM explore_album_covers WHERE slug = ? AND album_index = ?')
    .get(slug, albumIndex);
  if (!row) return null;
  if (!row.cover_url) return null;
  const coverUrl = safeExternalImageUrl(row.cover_url);
  if (!coverUrl) return null;
  exploreCoverMemoryCache.set(memoryKey, coverUrl);
  return coverUrl;
}

function saveExploreCover(slug, albumIndex, album, coverUrl) {
  const safeCoverUrl = safeExternalImageUrl(coverUrl);
  if (!safeCoverUrl) return;
  saveAlbumCover(album.title || '', album.artist || '', safeCoverUrl, `explore:${slug}`);
  const memoryKey = `${slug}:${albumIndex}`;
  exploreCoverMemoryCache.set(memoryKey, safeCoverUrl);
  db.prepare(
    `INSERT INTO explore_album_covers (slug, album_index, title, artist, cover_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug, album_index) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       cover_url = excluded.cover_url,
     updated_at = excluded.updated_at`
  ).run(slug, albumIndex, album.title || '', album.artist || '', safeCoverUrl, nowIso());
}

function clearExploreCover(slug, albumIndex) {
  exploreCoverMemoryCache.delete(`${slug}:${albumIndex}`);
  db.prepare('DELETE FROM explore_album_covers WHERE slug = ? AND album_index = ?').run(slug, albumIndex);
}

async function firstWorkingCover(candidates) {
  for (const candidate of uniqueBy(candidates.map(safeExternalImageUrl).filter(Boolean), (coverUrl) => coverUrl)) {
    if (await imageUrlWorks(candidate)) return candidate;
  }
  return '';
}

async function resolveExploreCover(slug, albumIndex, album, options = {}) {
  const force = Boolean(options.force);
  const providedCoverUrl = safeExternalImageUrl(album.coverUrl);
  if (!force && providedCoverUrl) {
    if (await imageUrlWorks(providedCoverUrl)) {
      saveExploreCover(slug, albumIndex, album, providedCoverUrl);
      return providedCoverUrl;
    }
    clearBadAlbumCoverReferences(album.title, album.artist, [providedCoverUrl]);
  }
  const cached = force ? null : cachedExploreCover(slug, albumIndex);
  if (cached !== null) {
    if (await imageUrlWorks(cached)) return cached;
    clearExploreCover(slug, albumIndex);
    clearBadAlbumCoverReferences(album.title, album.artist, [cached]);
  }
  const albumCached = force ? '' : cachedAlbumCover(album.title, album.artist);
  if (albumCached) {
    if (await imageUrlWorks(albumCached)) {
      saveExploreCover(slug, albumIndex, album, albumCached);
      return albumCached;
    }
    clearBadAlbumCoverReferences(album.title, album.artist, [albumCached]);
  }
  const candidates = [];
  const spotifyCover = await spotifyAlbumCover(album.spotifyId);
  if (spotifyCover) candidates.push(spotifyCover);
  const results = await albumLookupCandidatesForInput(album.title, album.artist, 'US').catch(() => []);
  const exact = results.find(
    (item) => normalizeText(item.title).includes(normalizeText(album.title)) && normalizeText(item.artist).includes(normalizeText(album.artist))
  );
  if (exact?.coverUrl) candidates.push(exact.coverUrl);
  candidates.push(...results.map((result) => result.coverUrl));
  if (force && providedCoverUrl) candidates.push(providedCoverUrl);
  const coverUrl = await firstWorkingCover(candidates);
  saveExploreCover(slug, albumIndex, album, coverUrl);
  if (!coverUrl && force) clearExploreCover(slug, albumIndex);
  return coverUrl;
}

function exploreContextFromJob(job) {
  const match = String(job?.source_context || '').match(/^explore:([^:]+):(\d+)$/);
  if (!match) return null;
  const slug = match[1];
  const albumIndex = Number(match[2]);
  const list = exploreListBySlug(slug);
  if (!list || !Number.isInteger(albumIndex) || albumIndex < 0 || albumIndex >= list.albums.length) return null;
  return { list, album: list.albums[albumIndex], index: albumIndex };
}

async function lookupAlbumForMetadataJob(job) {
  const providerId = clampText(job.provider_id, 220);
  if (providerId && !providerId.startsWith('spotify:')) {
    const lookup = await lookupAlbum(providerId, 'US').catch(() => null);
    if (lookup?.title) return lookup;
  }

  const title = clampText(job.title, 160);
  const artist = clampText(job.artist, 160);
  const candidates = await albumLookupCandidatesForInput(title, artist, 'US').catch(() => []);
  for (const candidate of candidates.slice(0, 6)) {
    if (!albumMetadataMatchesInput(candidate, title, artist)) continue;
    const lookup = await lookupAlbum(candidate.providerId, 'US').catch(() => null);
    if (lookup?.title) return lookup;
  }

  return {
    title,
    artist,
    coverUrl: cachedAlbumCoverValue(title, artist),
    tracks: []
  };
}

async function cacheLocalCoverForAlbum(albumInput, sourceContext = '') {
  const title = clampText(albumInput?.title, 160);
  if (!title) return null;
  const artist = clampText(albumInput?.artist, 160);
  const key = albumKey(title, artist);
  const existing = cachedLocalCover(key);
  if (existing) return { publicPath: existing, reused: true };
  const sourceUrl =
    coverSourceForAlbum(key) ||
    (isLocalCoverPublicPath(albumInput?.coverUrl || albumInput?.cover_url) ? '' : safeExternalImageUrl(albumInput?.coverUrl || albumInput?.cover_url)) ||
    storedAlbumCoverCandidates(title, artist).find((candidate) => !isLocalCoverPublicPath(candidate));
  if (!sourceUrl) return null;
  const downloaded = await downloadAlbumCover({
    albumKey: key,
    title,
    artist,
    sourceUrl
  });
  if (downloaded?.publicPath) {
    upsertAlbumHydrationStatus(
      { albumKey: key, title, artist },
      { coverStatus: 'complete', coverUpdatedAt: nowIso(), lastError: '' }
    );
    clearAlbumCoverLookupFailure(key);
  }
  const context = sourceContext || albumInput?.sourceContext || albumInput?.source_context || '';
  const exploreContext = context ? exploreContextFromJob({ source_context: context }) : null;
  if (downloaded?.publicPath && exploreContext) {
    saveExploreCover(exploreContext.list.slug, exploreContext.index, exploreContext.album, downloaded.publicPath);
  }
  return downloaded;
}

async function hydrateAlbumMetadataJob(job) {
  const lookup = await lookupAlbumForMetadataJob(job);
  const title = clampText(lookup?.title || job.title, 160);
  const artist = clampText(lookup?.artist || job.artist, 160);
  const coverUrl = preferredCoverUrlForAlbum(lookup) || cachedAlbumCoverValue(title, artist);
  const tracks = sanitizeTracks(lookup?.tracks);
  const source = clampText(job.source_context || 'metadata-worker', 80);
  const albumInput = { title, artist, coverUrl, tracks };
  if (tracks.length) saveCanonicalAlbumTracks(albumInput, source);
  else saveCanonicalAlbumMetadata(albumInput, source);
  syncHydratedAlbumToLists(albumInput);
  await cacheLocalCoverForAlbum({ ...albumInput, sourceContext: job.source_context }, job.source_context);
}

async function hydrateTracklistJob(job) {
  if (cachedTracksForAlbumKey(job.album_key).length) {
    copyCachedTracksToListAlbums(job.album_key);
    markHydrationJobStatus(job, 'complete');
    return;
  }
  const lookup = await lookupAlbumForMetadataJob(job);
  const tracks = sanitizeTracks(lookup?.tracks);
  if (!tracks.length) {
    markHydrationJobStatus(job, 'failed', 'No tracks found for album.');
    return;
  }
  const albumInput = {
    title: clampText(lookup.title || job.title, 160),
    artist: clampText(lookup.artist || job.artist, 160),
    coverUrl: preferredCoverUrlForAlbum(lookup) || cachedAlbumCoverValue(job.title, job.artist),
    tracks
  };
  saveCanonicalAlbumTracks(albumInput, clampText(job.source_context || 'tracklist-worker', 80));
  syncHydratedAlbumToLists(albumInput);
}

async function hydrateCoverJob(job) {
  const title = clampText(job.title, 160);
  const artist = clampText(job.artist, 160);
  const key = albumKey(title, artist);
  const existing = cachedLocalCover(key);
  if (existing) {
    const exploreContext = exploreContextFromJob(job);
    if (exploreContext) saveExploreCover(exploreContext.list.slug, exploreContext.index, exploreContext.album, existing);
    markHydrationJobStatus(job, 'complete');
    clearAlbumCoverLookupFailure(key);
    return;
  }

  let sourceUrl = coverSourceForAlbum(key);
  const providerId = clampText(job.provider_id, 220);
  if (!sourceUrl && providerId.startsWith('spotify:')) {
    sourceUrl = await spotifyAlbumCover(providerId.slice('spotify:'.length)).catch(() => '');
  }
  if (!sourceUrl) {
    const metadataCover = cachedAlbumCoverValue(title, artist);
    if (metadataCover && !isLocalCoverPublicPath(metadataCover)) sourceUrl = metadataCover;
  }
  if (sourceUrl && !(await imageUrlWorks(sourceUrl))) {
    clearBadAlbumCoverReferences(title, artist, [sourceUrl]);
    sourceUrl = '';
  }
  if (!sourceUrl && providerId && !providerId.startsWith('spotify:')) {
    const lookup = await lookupAlbum(providerId, 'US').catch(() => null);
    sourceUrl = await firstWorkingCover(coverCandidatesForLookupAlbum(lookup));
    if (sourceUrl) saveCanonicalAlbumMetadata({ title: lookup?.title || title, artist: lookup?.artist || artist, coverUrl: sourceUrl }, 'cover-worker');
  }
  if (!sourceUrl) sourceUrl = await resolveVerifiedAlbumCover(title, artist, 'US').catch(() => '');
  if (!sourceUrl || isLocalCoverPublicPath(sourceUrl)) {
    markHydrationJobStatus(job, 'failed', 'No working cover found.');
    return;
  }
  rememberCoverSource(key, sourceUrl);
  try {
    await cacheLocalCoverForAlbum({ title, artist, coverUrl: sourceUrl, sourceContext: job.source_context }, job.source_context);
    clearAlbumCoverLookupFailure(key);
    markHydrationJobStatus(job, 'complete');
  } catch (error) {
    recordAlbumCoverLookupFailure(title, artist, job.kind || 'cover', error?.message || error);
    throw error;
  }
}

function listAlbumsForAlbumKey(albumKeyValue) {
  return db.prepare('SELECT * FROM list_albums WHERE album_key = ? ORDER BY updated_at DESC, id DESC').all(albumKeyValue);
}

function dbAlbumMetadata(albumKeyValue) {
  const activity = db
    .prepare(
      `SELECT title, artist, cover_url
       FROM user_album_activity
       WHERE album_key = ? AND (title != '' OR artist != '' OR cover_url != '')
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(albumKeyValue);
  if (activity) return activity;

  const cached = cachedAlbumMetadata(albumKeyValue);
  if (cached) return cached;

  return db
    .prepare(
      `SELECT title, artist, cover_url
       FROM list_albums
       WHERE album_key = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(albumKeyValue);
}

function sourceAlbumMetadata(albumKeyValue) {
  const metadata = dbAlbumMetadata(albumKeyValue);
  if (metadata) return metadata;

  const source = exploreAlbumSourceByKey(albumKeyValue);
  if (source) {
    return {
      title: source.album.title,
      artist: source.album.artist || '',
      cover_url:
        safeExternalImageUrl(source.album.coverUrl) ||
        cachedExploreCover(source.list.slug, source.index) ||
        cachedAlbumCoverValue(source.album.title, source.album.artist)
    };
  }

  return null;
}

function viewerAlbumMetadata(albumKeyValue, user) {
  const source = exploreAlbumSourceByKey(albumKeyValue);
  if (source) {
    const cached = cachedAlbumMetadata(albumKeyValue);
    return {
      title: source.album.title,
      artist: source.album.artist || '',
      cover_url:
        safeExternalImageUrl(source.album.coverUrl) ||
        safeExternalImageUrl(cached?.cover_url) ||
        cachedExploreCover(source.list.slug, source.index) ||
        cachedAlbumCoverValue(source.album.title, source.album.artist)
    };
  }

  if (user) {
    const activity = db
      .prepare(
        `SELECT title, artist, cover_url
         FROM user_album_activity
         WHERE user_id = ? AND album_key = ? AND (title != '' OR artist != '' OR cover_url != '')
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(user.id, albumKeyValue);
    if (activity) return activity;

    const memberAlbum = db
      .prepare(
        `SELECT la.title, la.artist, la.cover_url
         FROM list_albums la
         JOIN list_members lm ON lm.list_id = la.list_id AND lm.user_id = ?
         WHERE la.album_key = ?
         ORDER BY la.updated_at DESC, la.id DESC
         LIMIT 1`
      )
      .get(user.id, albumKeyValue);
    if (memberAlbum) return memberAlbum;
  }

  return db
    .prepare(
      `SELECT la.title, la.artist, la.cover_url
       FROM list_albums la
       JOIN lists l ON l.id = la.list_id
       WHERE la.album_key = ? AND l.visibility = 'public'
       ORDER BY la.updated_at DESC, la.id DESC
       LIMIT 1`
    )
    .get(albumKeyValue);
}

function syncHydratedAlbumToLists(albumInput) {
  const title = clampText(albumInput?.title, 160);
  if (!title) return;
  const artist = clampText(albumInput?.artist, 160);
  const key = albumKey(title, artist);
  for (const album of listAlbumsForAlbumKey(key)) {
    updateExistingAlbumFromInput(album, albumInput, album.list_id);
  }
}

async function hydratedAlbumInputForKey(albumKeyValue, req, options = {}) {
  const metadata = viewerAlbumMetadata(albumKeyValue, req.user);
  if (!metadata) throw httpError(404, 'Album not found.');

  const title = clampText(metadata.title, 160);
  if (!title || albumKey(title, metadata.artist || '') !== albumKeyValue) throw httpError(404, 'Album not found.');

  const artist = clampText(metadata.artist, 160);
  const source = exploreAlbumSourceByKey(albumKeyValue);
  const rejectedCoverUrls = new Set(safeCoverUrlList(options.brokenCoverUrls || []));
  const forceCoverRefresh = Boolean(options.forceCoverRefresh);
  const forceMetadataRefresh = Boolean(options.forceMetadataRefresh);
  const fast = Boolean(options.fast);
  if (forceCoverRefresh) clearAlbumCoverLookupFailure(albumKeyValue);
  let coverUrl = '';
  const storedCoverUrl = safeExternalImageUrl(metadata.cover_url) || cachedAlbumCover(title, artist);
  if (storedCoverUrl) {
    if (fast && !forceCoverRefresh && !rejectedCoverUrls.has(storedCoverUrl)) {
      coverUrl = storedCoverUrl;
    } else if (!forceCoverRefresh && !rejectedCoverUrls.has(storedCoverUrl) && (await imageUrlWorks(storedCoverUrl))) {
      coverUrl = storedCoverUrl;
    } else {
      rejectedCoverUrls.add(storedCoverUrl);
      clearBadAlbumCoverReferences(title, artist, [...rejectedCoverUrls]);
    }
  }
  let tracks = forceMetadataRefresh ? [] : existingTracksForAlbumKey(albumKeyValue);
  let usedAlbumLookupRateLimit = false;

  if (!coverUrl && source && !forceCoverRefresh) {
    limitExploreCoverLookup(req);
    coverUrl = await resolveExploreCover(source.list.slug, source.index, source.album).catch(() => '');
    if (coverUrl && rejectedCoverUrls.has(coverUrl)) coverUrl = '';
  }

  if (!fast && (!tracks.length || forceMetadataRefresh)) {
    usedAlbumLookupRateLimit = true;
    const hydrated = await hydrateAlbumInputTracks({ title, artist, coverUrl }, req);
    tracks = sanitizeTracks(hydrated?.tracks);
    const hydratedCoverUrl = safeExternalImageUrl(hydrated?.coverUrl || hydrated?.cover_url);
    if (hydratedCoverUrl && !rejectedCoverUrls.has(hydratedCoverUrl)) {
      if (await imageUrlWorks(hydratedCoverUrl)) coverUrl = hydratedCoverUrl;
      else rejectedCoverUrls.add(hydratedCoverUrl);
    }
  }

  if (!fast && (!coverUrl || forceCoverRefresh || forceMetadataRefresh)) {
    if (!usedAlbumLookupRateLimit) limitAlbumLookup(req);
    coverUrl = await resolveVerifiedAlbumCover(title, artist, itunesCountry(req), [...rejectedCoverUrls]).catch(() => '');
  }

  if (coverUrl) {
    repairAlbumCoverReferences(
      title,
      artist,
      coverUrl,
      [...rejectedCoverUrls],
      source ? `explore:${source.list.slug}` : 'album-detail'
    );
    if (source) saveExploreCover(source.list.slug, source.index, source.album, coverUrl);
    if (!fast && !isLocalCoverPublicPath(coverUrl)) {
      const localCover = await cacheLocalCoverForAlbum(
        {
          title,
          artist,
          coverUrl,
          sourceContext: source ? `explore:${source.list.slug}:${source.index}` : 'album-detail'
        },
        source ? `explore:${source.list.slug}:${source.index}` : 'album-detail'
      );
      if (localCover?.publicPath) coverUrl = localCover.publicPath;
    }
  }

  const albumInput = { title, artist, coverUrl, tracks };
  saveCanonicalAlbumTracks(albumInput, source ? `explore:${source.list.slug}` : 'album-detail');
  syncHydratedAlbumToLists(albumInput);
  if (fast && (!tracks.length || !cachedLocalCover(albumKeyValue))) {
    queueAlbumHydrationJobs(
      {
        title,
        artist,
        coverUrl,
        sourceContext: source ? `explore:${source.list.slug}:${source.index}` : 'album-detail'
      },
      {
        priority: 35,
        sourceContext: source ? `explore:${source.list.slug}:${source.index}` : 'album-detail'
      }
    );
  }
  const hydrationStatus = clientHydrationStatus(albumKeyValue, title, artist, {
    tracks,
    coverUrl
  });
  return {
    album_key: albumKeyValue,
    title,
    artist,
    cover_url: coverUrl,
    tracks,
    hydration_status: hydrationStatus,
    hydration_pending: hydrationPendingFromStatus(hydrationStatus, tracks)
  };
}

function trackPayloadForAlbum(albumKeyValue, track, index, user) {
  const trackKeyValue = track.trackKey || track.track_key || trackKey(track.title, index + 1);
  const userRating = user
    ? db
        .prepare(
          `SELECT rating, include_in_average, updated_at
           FROM track_ratings
           WHERE user_id = ? AND album_key = ? AND track_key = ?`
        )
        .get(user.id, albumKeyValue, trackKeyValue)
    : null;

  return {
    id: index + 1,
    title: track.title,
    discNumber: track.discNumber || track.disc_number || 1,
    position: track.position || index + 1,
    trackKey: trackKeyValue,
    userRating: userRating
      ? {
          rating: userRating.rating,
          includeInAverage: Boolean(userRating.include_in_average),
          updatedAt: userRating.updated_at
        }
      : null,
    aggregate: albumRatingAggregate(albumKeyValue, trackKeyValue),
    sharedAggregate: null
  };
}

function buildCanonicalAlbumPayload(album, user) {
  const albumKeyValue = album.album_key;
  const hydrationStatus =
    album.hydration_status ||
    clientHydrationStatus(albumKeyValue, album.title, album.artist, {
      tracks: album.tracks || [],
      coverUrl: album.cover_url
    });
  const optInRow = user
    ? db.prepare('SELECT include_in_average FROM album_average_opt_in WHERE user_id = ? AND album_key = ?').get(user.id, albumKeyValue)
    : null;
  const albumLevelRating = user
    ? db
        .prepare(
          `SELECT rating, include_in_average, updated_at
           FROM track_ratings
           WHERE user_id = ? AND album_key = ? AND track_key = ?`
        )
        .get(user.id, albumKeyValue, albumLevelTrackKey)
    : null;
  const personalAlbum = user
    ? db
        .prepare(
          `SELECT la.id, la.list_id
           FROM list_albums la
           JOIN lists l ON l.id = la.list_id
           WHERE l.owner_user_id = ? AND l.kind = 'personal' AND la.album_key = ?
           LIMIT 1`
        )
        .get(user.id, albumKeyValue)
    : null;
  const personalAverage = user ? userAlbumAverage(user.id, albumKeyValue) : null;
  const currentUserAggregate = user ? userAlbumAverage(user.id, albumKeyValue) : null;

  return {
    albumKey: albumKeyValue,
    title: album.title,
    artist: album.artist || '',
    coverUrl: safeExternalImageUrl(album.cover_url),
    externalUrl: albumExternalUrl(album, user?.musicPlatform || 'na'),
    tracks: album.tracks.map((track, index) => trackPayloadForAlbum(albumKeyValue, track, index, user)),
    hydrationStatus,
    hydrationPending: hydrationPendingFromStatus(hydrationStatus, album.tracks || []),
    currentUserCompleted: Boolean(user && userAlbumFullyListened(user.id, albumKeyValue)),
    currentUserFullyRated: Boolean(user && userAlbumFullyRated(user.id, albumKeyValue)),
    currentUserAverageOptIn: optInRow ? Boolean(optInRow.include_in_average) : true,
    currentUserAlbumRating: albumLevelRating
      ? {
          rating: albumLevelRating.rating,
          includeInAverage: Boolean(albumLevelRating.include_in_average),
          updatedAt: albumLevelRating.updated_at
        }
      : null,
    currentUserAggregate,
    currentUserLibrary: personalAlbum
      ? {
          listId: personalAlbum.list_id,
          albumId: personalAlbum.id,
          average: personalAverage.average,
          ratingCount: personalAverage.count
        }
      : null,
    aggregate: albumRatingAggregate(albumKeyValue)
  };
}

function writeCanonicalRating(user, album, trackKeyValue, trackTitle, rating, include) {
  transaction(() => {
    const ratedAt = nowIso();
    db.prepare(
      `INSERT INTO track_ratings (user_id, album_key, track_key, track_title, rating, include_in_average, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, album_key, track_key) DO UPDATE
       SET track_title = excluded.track_title,
           rating = excluded.rating,
           include_in_average = excluded.include_in_average,
           updated_at = excluded.updated_at`
    ).run(user.id, album.album_key, trackKeyValue, trackTitle, rating, include, ratedAt);
    upsertUserAlbumActivity(user.id, album, {
      ratedAt,
      completedAt: userAlbumFullyListened(user.id, album.album_key) ? ratedAt : undefined
    });
  })();
}

function popularSharedLists(limit = 8) {
  return db
    .prepare(
      `SELECT l.*,
        lm.role,
        owner.username AS owner_username,
        COUNT(DISTINCT la.id) AS album_count,
        COUNT(DISTINCT members.user_id) AS member_count,
        COUNT(DISTINCT ac.user_id || ':' || ac.list_album_id) AS listen_count
       FROM lists l
       JOIN users owner ON owner.id = l.owner_user_id AND owner.disabled_at IS NULL
       JOIN list_members lm ON lm.list_id = l.id AND lm.user_id = l.owner_user_id
       LEFT JOIN list_albums la ON la.list_id = l.id
       LEFT JOIN list_members members ON members.list_id = l.id
       LEFT JOIN album_completions ac ON ac.list_album_id = la.id
       WHERE l.kind = 'collab'
         AND l.visibility = 'public'
         AND l.share_token IS NOT NULL
         AND l.share_token != ''
       GROUP BY l.id
       HAVING COUNT(DISTINCT la.id) > 0
       ORDER BY member_count DESC, listen_count DESC, album_count DESC, l.updated_at DESC
       LIMIT ?`
    )
    .all(limit)
    .map((row) => ({
      ...formatListSummary(row, { includeShareToken: true }),
      listenCount: row.listen_count || 0
    }));
}

function albumMetadata(albumKeyValue) {
  return sourceAlbumMetadata(albumKeyValue) || { title: albumKeyValue, artist: '', cover_url: '' };
}

function userKnownAlbumKeys(userId) {
  return new Set(
    db
      .prepare(
        `SELECT album_key FROM user_album_activity WHERE user_id = ?
         UNION
         SELECT album_key FROM track_ratings WHERE user_id = ?
         UNION
         SELECT la.album_key
         FROM list_albums la
         JOIN list_members lm ON lm.list_id = la.list_id
         WHERE lm.user_id = ?`
      )
      .all(userId, userId, userId)
      .map((row) => row.album_key)
  );
}

function buildRecommendations(user, limit = 12) {
  const knownKeys = userKnownAlbumKeys(user.id);
  const highKeys = db
    .prepare(
      `SELECT album_key, AVG(rating) AS average_rating
       FROM track_ratings
       WHERE user_id = ?
       GROUP BY album_key
       HAVING average_rating >= 7`
    )
    .all(user.id)
    .map((row) => row.album_key);

  const highKeySet = new Set(highKeys);
  const similarUserIds =
    highKeys.length > 0
      ? db
          .prepare(
            `SELECT DISTINCT user_id
             FROM track_ratings
             WHERE user_id != ?
               AND rating >= 7
               AND album_key IN (${highKeys.map(() => '?').join(',')})`
          )
          .all(user.id, ...highKeys)
          .map((row) => row.user_id)
      : [];

  const candidateRows =
    similarUserIds.length > 0
      ? db
          .prepare(
            `SELECT album_key, AVG(rating) AS average_rating, COUNT(DISTINCT user_id) AS listener_count
             FROM track_ratings
             WHERE user_id IN (${similarUserIds.map(() => '?').join(',')})
             GROUP BY album_key
             HAVING average_rating >= 7
             ORDER BY listener_count DESC, average_rating DESC
             LIMIT 100`
          )
          .all(...similarUserIds)
      : db
          .prepare(
            `SELECT album_key, AVG(rating) AS average_rating, COUNT(DISTINCT user_id) AS listener_count
             FROM track_ratings
             WHERE user_id != ?
             GROUP BY album_key
             HAVING average_rating >= 7
             ORDER BY listener_count DESC, average_rating DESC
             LIMIT 100`
          )
          .all(user.id);

  const recommendations = [];
  for (const row of candidateRows) {
    if (knownKeys.has(row.album_key) || highKeySet.has(row.album_key)) continue;
    const metadata = albumMetadata(row.album_key);
    recommendations.push({
      albumKey: row.album_key,
      title: metadata.title,
      artist: metadata.artist || '',
      coverUrl: safeExternalImageUrl(metadata.cover_url),
      score: Math.round(Number(row.average_rating || 0) * 10) / 10,
      listenerCount: row.listener_count || 0,
      reason: similarUserIds.length > 0 ? 'People with similar ratings liked this.' : 'Popular with other listeners.'
    });
    if (recommendations.length >= limit) break;
  }

  if (recommendations.length >= Math.min(4, limit)) return recommendations;

  for (const list of visibleExploreLists().slice(0, 3)) {
    for (const album of list.albums) {
      const key = albumKey(album.title, album.artist);
      if (knownKeys.has(key) || recommendations.some((item) => item.albumKey === key)) continue;
      recommendations.push({
        albumKey: key,
        title: album.title,
        artist: album.artist,
        coverUrl: safeExternalImageUrl(album.coverUrl),
        score: null,
        listenerCount: 0,
        reason: `From ${list.name}.`
      });
      if (recommendations.length >= limit) return recommendations;
    }
  }

  return recommendations;
}

function cleanupActiveVisitors() {
  const cutoff = new Date(Date.now() - activeVisitorRetentionMs).toISOString();
  db.prepare('DELETE FROM active_visitors WHERE last_seen_at < ?').run(cutoff);
}

function pruneSearchCacheRows() {
  const expiredBefore = new Date(Date.now() - searchCacheStaleRetentionMs).toISOString();
  const expired = db.prepare('DELETE FROM album_search_cache WHERE expires_at IS NOT NULL AND expires_at < ?').run(expiredBefore).changes;
  const overflow = db
    .prepare(
      `DELETE FROM album_search_cache
       WHERE search_key IN (
         SELECT search_key
         FROM album_search_cache
         ORDER BY updated_at DESC, search_key DESC
         LIMIT -1 OFFSET ?
       )`
    )
    .run(config.searchCacheMaxRows).changes;
  return { expired, overflow };
}

function pruneCoverProbeCacheRows() {
  const expired = db.prepare('DELETE FROM cover_probe_cache WHERE expires_at < ?').run(nowIso()).changes;
  const overflow = db
    .prepare(
      `DELETE FROM cover_probe_cache
       WHERE url_hash IN (
         SELECT url_hash
         FROM cover_probe_cache
         ORDER BY checked_at DESC, url_hash DESC
         LIMIT -1 OFFSET ?
       )`
    )
    .run(config.coverProbeMaxRows).changes;
  return { expired, overflow };
}

function prunePersistentCacheRows() {
  return {
    searchCache: pruneSearchCacheRows(),
    coverProbeCache: pruneCoverProbeCacheRows(),
    metadataJobsDeleted: pruneMetadataJobs()
  };
}

function searchCacheDiagnostics() {
  const now = nowIso();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN expires_at IS NULL OR expires_at > ? THEN 1 ELSE 0 END) AS fresh,
              SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS stale,
              MAX(updated_at) AS newest_updated_at
       FROM album_search_cache`
    )
    .get(now, now);
  return {
    rows: Number(row?.rows || 0),
    fresh: Number(row?.fresh || 0),
    stale: Number(row?.stale || 0),
    maxRows: config.searchCacheMaxRows,
    ttlHours: config.searchCacheTtlHours,
    newestUpdatedAt: row?.newest_updated_at || null
  };
}

function coverProbeCacheDiagnostics() {
  const now = nowIso();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS successes,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS expired,
              MAX(checked_at) AS newest_checked_at
       FROM cover_probe_cache`
    )
    .get(now);
  return {
    rows: Number(row?.rows || 0),
    successes: Number(row?.successes || 0),
    failures: Number(row?.failures || 0),
    expired: Number(row?.expired || 0),
    maxRows: config.coverProbeMaxRows,
    successTtlHours: config.coverProbeSuccessTtlHours,
    failureTtlHours: config.coverProbeFailureTtlHours,
    newestCheckedAt: row?.newest_checked_at || null
  };
}

function coverLookupFailureDiagnostics() {
  const now = nowIso();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN next_retry_at > ? THEN 1 ELSE 0 END) AS backed_off,
              SUM(CASE WHEN next_retry_at <= ? THEN 1 ELSE 0 END) AS retry_due,
              MAX(updated_at) AS newest_updated_at
       FROM album_cover_lookup_failures`
    )
    .get(now, now);
  return {
    rows: Number(row?.rows || 0),
    backedOff: Number(row?.backed_off || 0),
    retryDue: Number(row?.retry_due || 0),
    newestUpdatedAt: row?.newest_updated_at || null
  };
}

function cacheDiagnostics() {
  return {
    search: searchCacheDiagnostics(),
    coverProbe: coverProbeCacheDiagnostics(),
    coverLookupFailures: coverLookupFailureDiagnostics()
  };
}

function safeVisitorId(value) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,80}$/.test(text) ? text : randomToken(24);
}

function safeClientPath(value) {
  const text = clampText(value, 300);
  return text.startsWith('/') && !text.startsWith('//') ? text : '/';
}

app.get(
  '/api/health',
  route((req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: nowIso(), uptimeSeconds: Math.round(process.uptime()), database: 'ok' });
  })
);

app.get(
  '/api/ops/diagnostics',
  route((req, res) => {
    requireLocalRequest(req);
    db.prepare('SELECT 1').get();
    const databasePath = config.databasePath;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      time: nowIso(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      database: {
        mainBytes: fileSize(databasePath),
        walBytes: fileSize(`${databasePath}-wal`),
        shmBytes: fileSize(`${databasePath}-shm`)
      },
      metadataQueue: metadataQueueDiagnostics(),
      persistentCaches: cacheDiagnostics(),
      hydrationStatus: hydrationStatusCounts(),
      localCoverCache: localCoverCacheSummary(),
      rateLimitBuckets: rateLimitBuckets.size
    });
  })
);

app.post(
  '/api/activity/heartbeat',
  route((req, res) => {
    enforceRateLimit(req, 'activity-heartbeat', {
      limit: 180,
      windowMs: 60 * 1000,
      key: rateLimitIdentity(req),
      message: 'Heartbeat is temporarily rate limited.'
    });

    cleanupActiveVisitors();
    const visitorId = safeVisitorId(req.body?.visitorId);
    const seenAt = nowIso();
    db.prepare(
      `INSERT INTO active_visitors (visitor_id, user_id, path, user_agent, ip_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(visitor_id) DO UPDATE SET
         user_id = excluded.user_id,
         path = excluded.path,
         user_agent = excluded.user_agent,
         ip_hash = excluded.ip_hash,
         last_seen_at = excluded.last_seen_at`
    ).run(
      visitorId,
      req.user?.id ?? null,
      safeClientPath(req.body?.path),
      clampText(req.get('user-agent'), 500),
      hashToken(clientIp(req)),
      seenAt,
      seenAt
    );

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, visitorId, activeWindowSeconds: Math.round(activeVisitorWindowMs / 1000) });
  })
);

app.get('/api/explore', (req, res) => {
  cachePublic(res, 60, 300);
  res.json({
    lists: visibleExploreLists().map(({ albums, ...list }) => list),
    popularLists: popularSharedLists()
  });
});

app.get(
  '/api/albums/by-key/:albumKey',
  route(async (req, res) => {
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, {
      fast: req.query.refresh !== '1' && req.query.refresh !== 'true'
    });
    res.setHeader('Cache-Control', req.user ? 'private, no-cache' : 'no-store');
    res.json({ album: buildCanonicalAlbumPayload(album, req.user) });
  })
);

app.post(
  '/api/albums/by-key/:albumKey/cover/refresh',
  route(async (req, res) => {
    limitDbWrite(req, 'canonical-cover-refresh');
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, {
      forceCoverRefresh: req.body?.force === true,
      brokenCoverUrls: [req.body?.brokenUrl]
    });
    res.setHeader('Cache-Control', req.user ? 'private, no-cache' : 'no-store');
    res.json({
      ok: true,
      coverUrl: safeExternalImageUrl(album.cover_url),
      album: buildCanonicalAlbumPayload(album, req.user)
    });
  })
);

app.post(
  '/api/albums/by-key/:albumKey/metadata/refresh',
  route(async (req, res) => {
    limitDbWrite(req, 'canonical-metadata-refresh');
    limitAlbumLookup(req);
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, {
      forceMetadataRefresh: true,
      forceCoverRefresh: req.body?.forceCover === true,
      brokenCoverUrls: [req.body?.brokenUrl]
    });
    res.setHeader('Cache-Control', req.user ? 'private, no-cache' : 'no-store');
    res.json({
      ok: true,
      album: buildCanonicalAlbumPayload(album, req.user)
    });
  })
);

app.post(
  '/api/albums/by-key/:albumKey/complete',
  route(async (req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'completion-write');
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, { fast: true });

    if (req.body?.completed === false) {
      transaction(() => {
        db.prepare('UPDATE user_album_activity SET completed_at = NULL, updated_at = ? WHERE user_id = ? AND album_key = ?').run(
          nowIso(),
          user.id,
          album.album_key
        );
        const rows = db
          .prepare(
            `SELECT ac.list_album_id
             FROM album_completions ac
             JOIN list_albums la ON la.id = ac.list_album_id
             JOIN list_members lm ON lm.list_id = la.list_id AND lm.user_id = ac.user_id
             WHERE ac.user_id = ? AND la.album_key = ?`
          )
          .all(user.id, album.album_key);
        const removeCompletion = db.prepare('DELETE FROM album_completions WHERE list_album_id = ? AND user_id = ?');
        for (const row of rows) removeCompletion.run(row.list_album_id, user.id);
      })();
    } else {
      transaction(() => {
        const completedAt = nowIso();
        upsertUserAlbumActivity(user.id, album, { completedAt });
        const rows = db
          .prepare(
            `SELECT la.id
             FROM list_albums la
             JOIN list_members lm ON lm.list_id = la.list_id AND lm.user_id = ?
             WHERE la.album_key = ?`
          )
          .all(user.id, album.album_key);
        const completeAlbum = db.prepare(
          `INSERT INTO album_completions (list_album_id, user_id, completed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(list_album_id, user_id) DO UPDATE SET completed_at = excluded.completed_at`
        );
        for (const row of rows) completeAlbum.run(row.id, user.id, completedAt);
      })();
    }

    res.json({ ok: true, album: buildCanonicalAlbumPayload(album, user) });
  })
);

app.patch(
  '/api/albums/by-key/:albumKey/rating-preferences',
  route(async (req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, { fast: true });
    const include = req.body?.includeInAverage === false ? 0 : 1;
    db.prepare(
      `INSERT INTO album_average_opt_in (user_id, album_key, include_in_average, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, album_key) DO UPDATE
       SET include_in_average = excluded.include_in_average, updated_at = excluded.updated_at`
    ).run(user.id, album.album_key, include, nowIso());
    res.json({ ok: true, album: buildCanonicalAlbumPayload(album, user) });
  })
);

app.put(
  '/api/albums/by-key/:albumKey/rating',
  route(async (req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, { fast: true });
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
      throw httpError(400, 'Rating must be a whole number from 0 to 10.');
    }
    const existingRating = db
      .prepare('SELECT include_in_average FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?')
      .get(user.id, album.album_key, albumLevelTrackKey);
    const include =
      req.body?.includeInAverage === undefined ? existingRating?.include_in_average ?? 1 : req.body.includeInAverage === false ? 0 : 1;
    writeCanonicalRating(user, album, albumLevelTrackKey, 'Album rating', rating, include);
    res.json({ ok: true, album: buildCanonicalAlbumPayload(album, user) });
  })
);

app.patch(
  '/api/albums/by-key/:albumKey/tracks/:trackKey/rating-preferences',
  route(async (req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, { fast: true });
    const trackKeyValue = clampText(req.params.trackKey, 220);
    const track = album.tracks.find((item, index) => (item.trackKey || trackKey(item.title, index + 1)) === trackKeyValue);
    if (!track) throw httpError(404, 'Track not found.');
    const existingRating = db
      .prepare('SELECT id FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?')
      .get(user.id, album.album_key, trackKeyValue);
    if (!existingRating) throw httpError(400, 'Rate this track before excluding it from album ratings.');
    const include = req.body?.includeInAverage === false ? 0 : 1;
    db.prepare(
      `UPDATE track_ratings
       SET include_in_average = ?, updated_at = ?
       WHERE user_id = ? AND album_key = ? AND track_key = ?`
    ).run(include, nowIso(), user.id, album.album_key, trackKeyValue);
    res.json({ ok: true, album: buildCanonicalAlbumPayload(album, user) });
  })
);

app.put(
  '/api/albums/by-key/:albumKey/tracks/:trackKey/rating',
  route(async (req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const album = await hydratedAlbumInputForKey(req.params.albumKey, req, { fast: true });
    const trackKeyValue = clampText(req.params.trackKey, 220);
    const track = album.tracks.find((item, index) => (item.trackKey || trackKey(item.title, index + 1)) === trackKeyValue);
    if (!track) throw httpError(404, 'Track not found.');

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
      throw httpError(400, 'Rating must be a whole number from 0 to 10.');
    }
    const existingRating = db
      .prepare('SELECT include_in_average FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?')
      .get(user.id, album.album_key, trackKeyValue);
    const include =
      req.body?.includeInAverage === undefined ? existingRating?.include_in_average ?? 1 : req.body.includeInAverage === false ? 0 : 1;
    writeCanonicalRating(user, album, trackKeyValue, track.title, rating, include);
    res.json({ ok: true, album: buildCanonicalAlbumPayload(album, user) });
  })
);

app.get(
  '/api/explore/random',
  route((req, res) => {
    const publicExploreLists = visibleExploreLists();
    const source = req.query.slug
      ? exploreListBySlug(String(req.query.slug))
      : publicExploreLists[Math.floor(Math.random() * publicExploreLists.length)];
    if (!source) throw httpError(404, 'Explore list not found.');
    if (!source.albums.length) throw httpError(404, 'Explore list has no albums.');
    const albumIndex = Math.floor(Math.random() * source.albums.length);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ slug: source.slug, albumIndex, album: source.albums[albumIndex] });
  })
);

app.get(
  '/api/explore/:slug',
  route((req, res) => {
    const list = exploreListBySlug(req.params.slug);
    if (!list) throw httpError(404, 'Explore list not found.');
    if (req.user) res.setHeader('Cache-Control', 'private, no-cache');
    else cachePublic(res, 120, 600);
    const payload = exploreListWithCachedCovers(list, req.user);
    queueExploreCoverJobsForList(payload, { priority: 90 });
    res.json({ list: payload });
  })
);

app.put(
  '/api/explore/:slug/albums/:index/rating',
  route(async (req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const list = exploreListBySlug(req.params.slug);
    if (!list) throw httpError(404, 'Explore list not found.');
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= list.albums.length) {
      throw httpError(404, 'Explore album not found.');
    }

    const sourceAlbum = list.albums[index];
    const title = clampText(sourceAlbum.title, 160);
    if (!title) throw httpError(400, 'Album title is required.');
    const artist = clampText(sourceAlbum.artist, 160);
    const key = albumKey(title, artist);
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
      throw httpError(400, 'Rating must be a whole number from 0 to 10.');
    }
    const album = await hydratedAlbumInputForKey(key, req, { fast: true });

    const existingRating = db
      .prepare('SELECT include_in_average FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?')
      .get(user.id, album.album_key, albumLevelTrackKey);
    const include =
      req.body?.includeInAverage === undefined ? existingRating?.include_in_average ?? 1 : req.body.includeInAverage === false ? 0 : 1;
    writeCanonicalRating(user, album, albumLevelTrackKey, 'Album rating', rating, include);

    res.setHeader('Cache-Control', 'private, no-cache');
    res.json({
      ok: true,
      album: exploreListWithCachedCovers(list, user).albums[index]
    });
  })
);

app.get(
  '/api/explore/:slug/covers',
  route((req, res) => {
    const list = exploreListBySlug(req.params.slug);
    if (!list) throw httpError(404, 'Explore list not found.');
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const limit = Math.min(24, Math.max(1, Number(req.query.limit || 24) || 24));
    const slice = list.albums.slice(offset, offset + limit);
    const covers = slice.map((album, index) => {
      const albumIndex = offset + index;
      const coverUrl =
        safeExternalImageUrl(album.coverUrl) ||
        cachedExploreCover(list.slug, albumIndex) ||
        cachedAlbumCoverValue(album.title, album.artist);
      queueCoverJobForAlbum(
        {
          ...album,
          providerId: album.spotifyId ? `spotify:${album.spotifyId}` : '',
          coverUrl,
          sourceContext: `explore:${list.slug}:${albumIndex}`
        },
        {
          priority: 90,
          sourceContext: `explore:${list.slug}:${albumIndex}`
        }
      );
      return { index: albumIndex, coverUrl: coverUrl || null };
    });
    cachePublic(res, 300, 900);
    res.json({ covers });
  })
);

app.post(
  '/api/explore/:slug/covers/warm',
  route((req, res) => {
    const list = exploreListBySlug(req.params.slug);
    if (!list) throw httpError(404, 'Explore list not found.');
    const offset = Math.max(0, Number(req.body?.offset || 0) || 0);
    const limit = Math.min(24, Math.max(1, Number(req.body?.limit || 24) || 24));
    const slice = list.albums.slice(offset, offset + limit);
    const covers = slice.map((album, index) => {
      const albumIndex = offset + index;
      const coverUrl =
        safeExternalImageUrl(album.coverUrl) ||
        cachedExploreCover(list.slug, albumIndex) ||
        cachedAlbumCoverValue(album.title, album.artist);
      queueCoverJobForAlbum(
        {
          ...album,
          providerId: album.spotifyId ? `spotify:${album.spotifyId}` : '',
          coverUrl,
          sourceContext: `explore:${list.slug}:${albumIndex}`
        },
        {
          priority: 90,
          sourceContext: `explore:${list.slug}:${albumIndex}`
        }
      );
      return { index: albumIndex, coverUrl: coverUrl || null };
    });
    res.json({ covers, nextOffset: offset + slice.length, total: list.albums.length });
  })
);

app.post(
  '/api/explore/:slug/covers/:index/refresh',
  route(async (req, res) => {
    limitExploreCoverLookup(req);
    const list = exploreListBySlug(req.params.slug);
    if (!list) throw httpError(404, 'Explore list not found.');
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= list.albums.length) {
      throw httpError(404, 'Explore album not found.');
    }
    const coverUrl = await resolveExploreCover(list.slug, index, list.albums[index], { force: true });
    res.json({ index, coverUrl });
  })
);

app.get(
  '/api/recommendations',
  route((req, res) => {
    const user = requireUser(req);
    res.json({ recommendations: buildRecommendations(user) });
  })
);

app.get(
  '/api/albums/search',
  route(async (req, res) => {
    limitAlbumSearch(req);
    const results = await searchAlbums(req.query.q, itunesCountry(req));
    queueSearchResultHydrationJobs(results);
    cachePublic(res, 300, 600);
    res.json({ results });
  })
);

app.get(
  '/api/albums/lookup/:providerId',
  route(async (req, res) => {
    limitAlbumLookup(req);
    const album = await lookupAlbum(req.params.providerId, itunesCountry(req));
    cachePublic(res, 600, 1800);
    res.json({ album });
  })
);

app.get(
  '/api/me',
  route((req, res) => {
    if (!req.user) {
      res.json({ user: null, lists: [], invites: [] });
      return;
    }
    ensurePersonalList(req.user.id);
    res.json({ user: req.user, lists: getUserLists(req.user.id), invites: getPendingInvites(req.user.id) });
  })
);

app.get(
  '/api/me/album-lists',
  route((req, res) => {
    const user = requireUser(req);
    const title = clampText(req.query.title, 160);
    if (!title) throw httpError(400, 'Album title is required.');
    const artist = clampText(req.query.artist, 160);
    const key = albumKey(title, artist);
    const items = db
      .prepare(
        `SELECT l.id AS list_id, l.name, l.kind, lm.role, la.id AS album_id
         FROM list_members lm
         JOIN lists l ON l.id = lm.list_id
         LEFT JOIN list_albums la ON la.list_id = l.id AND la.album_key = ?
         WHERE lm.user_id = ? AND lm.role IN ('owner', 'editor')
         ORDER BY l.kind = 'personal' DESC, l.updated_at DESC`
      )
      .all(key, user.id)
      .map((item) => ({
        listId: item.list_id,
        name: item.name,
        kind: item.kind,
        role: item.role,
        albumId: item.album_id || null
      }));
    res.json({ items });
  })
);

app.post(
  '/api/auth/register',
  route((req, res) => {
    checkAuthThrottle(req);
    const { username, email, password, musicPlatform } = validateAccountInput(req.body || {});
    const normalizedUsername = normalizeText(username);
    const normalizedEmail = normalizeEmail(email);

    const usernameExists = db.prepare('SELECT 1 FROM users WHERE username_normalized = ?').get(normalizedUsername);
    const emailExists = db.prepare('SELECT 1 FROM users WHERE email_normalized = ?').get(normalizedEmail);
    if (usernameExists && emailExists) {
      throw httpError(409, 'That username is already taken. That email is already in use.');
    }
    if (usernameExists) throw httpError(409, 'That username is already taken.');
    if (emailExists) throw httpError(409, 'That email is already in use.');

    const passwordHash = bcrypt.hashSync(password, 12);

    const tx = transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO users
           (username, username_normalized, email, email_normalized, password_hash, avatar_color, music_platform, history_token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(username, normalizedUsername, email, normalizedEmail, passwordHash, avatarFor(username), musicPlatform, uniqueTokenFor('users', 'history_token'), nowIso());
      const userId = Number(info.lastInsertRowid);
      ensurePersonalList(userId);
      const imported = importGuestAlbums(userId, req.body?.guestImport);
      return { userId, imported };
    });

    const { userId, imported } = tx();
    replaceCurrentSession(req, res, userId);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId), { includePrivate: true });
    res.status(201).json({ user, lists: getUserLists(userId), imported });
  })
);

app.post(
  '/api/auth/login',
  route((req, res) => {
    checkAuthThrottle(req);
    const identifier = String(req.body?.identifier || '').trim();
    const password = String(req.body?.password || '');
    if (!identifier || !password) throw httpError(400, 'Username/email and password are required.');

    const normalized = identifier.includes('@') ? normalizeEmail(identifier) : normalizeText(identifier);
    const userRow = db
      .prepare(
        `SELECT * FROM users
         WHERE username_normalized = ? OR email_normalized = ?`
      )
      .get(normalized, normalized);
    if (!userRow || !bcrypt.compareSync(password, userRow.password_hash)) {
      throw httpError(401, 'Invalid username/email or password.');
    }
    if (userRow.disabled_at) {
      throw httpError(403, 'This account is disabled.');
    }

    const imported = importGuestAlbums(userRow.id, req.body?.guestImport);
    replaceCurrentSession(req, res, userRow.id);
    res.json({ user: publicUser(userRow, { includePrivate: true }), lists: getUserLists(userRow.id), imported });
  })
);

app.post(
  '/api/auth/logout',
  route((req, res) => {
    deleteCurrentSession(req);
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

app.patch(
  '/api/me',
  route((req, res) => {
    const user = requireUser(req);
    enforceRateLimit(req, 'profile-update', {
      limit: 120,
      windowMs: 60 * 60 * 1000,
      message: 'Profile updates are temporarily rate limited. Try again later.'
    });
    const updates = {};
    if (['private', 'unlisted'].includes(req.body?.historyVisibility)) {
      updates.history_visibility = req.body.historyVisibility;
    }
    if (['system', 'light', 'dark', 'retro'].includes(req.body?.themePreference)) {
      updates.theme_preference = req.body.themePreference;
    }
    if (Object.hasOwn(req.body || {}, 'avatarDataUrl')) {
      limitAvatarUpload(req);
      updates.avatar_data_url = validateAvatarDataUrl(req.body.avatarDataUrl);
    }
    if (Object.hasOwn(req.body || {}, 'musicPlatform')) {
      updates.music_platform = normalizeMusicPlatform(req.body.musicPlatform);
    }
    if (Object.hasOwn(req.body || {}, 'accentColor')) {
      updates.accent_color = validateAccentColor(req.body.accentColor);
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      db.prepare(
        `UPDATE users SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`
      ).run(...keys.map((key) => updates[key]), user.id);
    }
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), { includePrivate: true }) });
  })
);

app.post(
  '/api/guest/import',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'guest-import');
    const imported = importGuestAlbums(user.id, req.body);
    res.json({ imported, lists: getUserLists(user.id) });
  })
);

app.get(
  '/api/lists',
  route((req, res) => {
    const user = requireUser(req);
    ensurePersonalList(user.id);
    res.json({ lists: getUserLists(user.id) });
  })
);

app.put(
  '/api/me/albums/:albumKey/ratings/:trackKey',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const albumKeyValue = clampText(req.params.albumKey, 320);
    const trackKeyValue = clampText(req.params.trackKey, 220);
    if (!albumKeyValue || !trackKeyValue) throw httpError(400, 'Rating id is required.');

    const existing = db
      .prepare(
        `SELECT track_title, include_in_average
         FROM track_ratings
         WHERE user_id = ? AND album_key = ? AND track_key = ?`
      )
      .get(user.id, albumKeyValue, trackKeyValue);
    if (!existing) throw httpError(404, 'Rating not found.');

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
      throw httpError(400, 'Rating must be a whole number from 0 to 10.');
    }

    const include =
      req.body?.includeInAverage === undefined
        ? existing.include_in_average
        : req.body.includeInAverage === false
          ? 0
          : 1;
    const trackTitle = clampText(req.body?.trackTitle || existing.track_title || 'Album rating', 160);
    const ratedAt = nowIso();
    db.prepare(
      `UPDATE track_ratings
       SET track_title = ?, rating = ?, include_in_average = ?, updated_at = ?
       WHERE user_id = ? AND album_key = ? AND track_key = ?`
    ).run(trackTitle, rating, include, ratedAt, user.id, albumKeyValue, trackKeyValue);

    const metadata = albumMetadata(albumKeyValue);
    upsertUserAlbumActivity(
      user.id,
      {
        album_key: albumKeyValue,
        title: metadata.title,
        artist: metadata.artist || '',
        cover_url: safeExternalImageUrl(metadata.cover_url)
      },
      {
        ratedAt,
        completedAt: userAlbumFullyListened(user.id, albumKeyValue) ? ratedAt : undefined
      }
    );

    res.json(buildUserProfile(user.username, user));
  })
);

app.get(
  '/api/users/:username',
  route((req, res) => {
    res.json(buildUserProfile(req.params.username, req.user));
  })
);

app.get(
  '/api/users',
  route((req, res) => {
    const user = requireUser(req);
    enforceRateLimit(req, 'user-search', {
      limit: 60,
      windowMs: 60 * 1000,
      message: 'User search is temporarily rate limited. Try again shortly.'
    });
    res.json({ users: searchUsers(req.query.q, user.id) });
  })
);

app.post(
  '/api/reports',
  route((req, res) => {
    limitBugReport(req);
    const user = req.user || null;
    const honeypot = clampText(req.body?.website, 200);
    if (honeypot) throw httpError(400, 'Report could not be submitted.');

    const openedAt = Number(req.body?.openedAt || 0);
    if (openedAt && Date.now() - openedAt < 1500) throw httpError(429, 'Report could not be submitted yet.');

    const body = clampText(req.body?.body, 2000);
    if (body.length < 10) throw httpError(400, 'Tell us a little more about the bug.');

    const urlCount = (body.match(/https?:\/\/|www\./gi) || []).length;
    if (urlCount > 2) throw httpError(400, 'Bug reports can include at most two links.');

    const path = clampText(req.body?.path, 300);
    const safePath = path.startsWith('/') && !path.startsWith('//') ? path : '';
    const ipHash = hashToken(clientIp(req));
    const bodyHash = hashToken(normalizeText(body));
    const title = clampText(req.body?.title, 160) || body.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 120) || 'Public bug report';
    const userAgent = clampText(req.get('user-agent'), 500);
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const duplicate = db
      .prepare(
        `SELECT id
         FROM bug_reports
         WHERE body_hash = ?
           AND created_at >= ?
           AND (ip_hash = ? OR (? IS NOT NULL AND user_id = ?))
         LIMIT 1`
      )
      .get(bodyHash, cutoff, ipHash, user?.id ?? null, user?.id ?? null);
    if (duplicate) throw httpError(429, 'This report was already submitted recently.');

    const info = db
      .prepare(
        `INSERT INTO bug_reports
         (title, description, status, priority, source, user_id, reporter_username, page_path, browser, user_agent, ip_hash, body_hash, created_at, updated_at)
         VALUES (?, ?, 'open', 'medium', 'public_report', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        body,
        user?.id ?? null,
        user?.username || '',
        safePath,
        userAgent,
        userAgent,
        ipHash,
        bodyHash,
        nowIso(),
        nowIso()
      );

    res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
  })
);

app.post(
  '/api/lists',
  route((req, res) => {
    const user = requireUser(req);
    enforceRateLimit(req, 'list-create', {
      limit: 20,
      windowMs: 60 * 60 * 1000,
      message: 'List creation is temporarily rate limited. Try again later.'
    });
    const kind = req.body?.kind === 'collab' ? 'collab' : null;
    if (!kind) throw httpError(400, 'Only collaborative lists can be created manually.');
    const listId = createList(user.id, 'collab', req.body?.name || 'Shared Albums');
    res.status(201).json({ list: buildListPayload(getListOrThrow(listId), user), lists: getUserLists(user.id) });
  })
);

app.get(
  '/api/invitations',
  route((req, res) => {
    const user = requireUser(req);
    res.json({ invites: getPendingInvites(user.id) });
  })
);

app.post(
  '/api/invitations/:inviteId/accept',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'invite-response');
    const invite = db
      .prepare(
        `SELECT li.*, l.kind
         FROM list_invites li
         JOIN lists l ON l.id = li.list_id
         WHERE li.id = ? AND li.invitee_user_id = ? AND li.status = 'pending'`
      )
      .get(Number(req.params.inviteId), user.id);
    if (!invite) throw httpError(404, 'Invite not found.');

    transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO list_members (list_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)`
      ).run(invite.list_id, user.id, invite.role, nowIso());
      db.prepare('UPDATE list_invites SET status = ?, responded_at = ? WHERE id = ?').run('accepted', nowIso(), invite.id);
    })();

    res.json({ ok: true, lists: getUserLists(user.id), invites: getPendingInvites(user.id) });
  })
);

app.post(
  '/api/invitations/:inviteId/decline',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'invite-response');
    const result = db
      .prepare(
        `UPDATE list_invites
         SET status = 'declined', responded_at = ?
         WHERE id = ? AND invitee_user_id = ? AND status = 'pending'`
      )
      .run(nowIso(), Number(req.params.inviteId), user.id);
    if (!result.changes) throw httpError(404, 'Invite not found.');
    res.json({ ok: true, invites: getPendingInvites(user.id) });
  })
);

app.get(
  '/api/lists/:id',
  route((req, res) => {
    const list = getListOrThrow(Number(req.params.id));
    sendListPayload(req, res, list, req.user, false);
  })
);

app.patch(
  '/api/lists/:id',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'list-settings');
    const list = getListOrThrow(Number(req.params.id));
    assertCanManage(list, user);
    const name = req.body?.name === undefined ? list.name : clampText(req.body.name, 80);
    const description = req.body?.description === undefined ? list.description : clampText(req.body.description, 500);
    const visibility = ['private', 'unlisted', 'public'].includes(req.body?.visibility) ? req.body.visibility : list.visibility;
    const showRatings = req.body?.showRatings === undefined ? list.show_ratings : req.body.showRatings ? 1 : 0;
    if (!name) throw httpError(400, 'List name is required.');

    db.prepare(
      `UPDATE lists
       SET name = ?, description = ?, visibility = ?, show_ratings = ?, updated_at = ?
       WHERE id = ?`
    ).run(name, description, visibility, showRatings, nowIso(), list.id);

    res.json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.post(
  '/api/lists/:id/share/regenerate',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'share-token');
    const list = getListOrThrow(Number(req.params.id));
    assertCanManage(list, user);
    db.prepare('UPDATE lists SET share_token = ?, updated_at = ? WHERE id = ?').run(
      uniqueTokenFor('lists', 'share_token'),
      nowIso(),
      list.id
    );
    res.json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.post(
  '/api/lists/:id/share/publish',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'share-token');
    const list = getListOrThrow(Number(req.params.id));
    assertCanManage(list, user);
    if (list.visibility === 'private') {
      db.prepare('UPDATE lists SET visibility = ?, updated_at = ? WHERE id = ?').run('unlisted', nowIso(), list.id);
    }
    res.json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.post(
  '/api/lists/:id/invite/regenerate',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'invite-token');
    const list = getListOrThrow(Number(req.params.id));
    assertCanManage(list, user);
    if (list.kind !== 'collab') throw httpError(400, 'Only collaborative lists have invite links.');
    db.prepare('UPDATE lists SET invite_token = ?, updated_at = ? WHERE id = ?').run(
      uniqueTokenFor('lists', 'invite_token'),
      nowIso(),
      list.id
    );
    res.json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.post(
  '/api/lists/:id/invites',
  route((req, res) => {
    const user = requireUser(req);
    limitInviteSending(req);
    const list = getListOrThrow(Number(req.params.id));
    assertCanManage(list, user);
    if (list.kind !== 'collab') throw httpError(400, 'Only collaborative lists can invite people.');

    const identifier = clampText(req.body?.identifier, 120);
    if (!identifier) throw httpError(400, 'Username or email is required.');
    const normalized = identifier.includes('@') ? normalizeEmail(identifier) : normalizeText(identifier);
    const invitee = db
      .prepare('SELECT * FROM users WHERE username_normalized = ? OR email_normalized = ?')
      .get(normalized, normalized);
    if (!invitee) throw httpError(404, 'No account found for that username or email.');
    if (invitee.id === user.id) throw httpError(400, 'You already own this list.');
    if (getMember(list.id, invitee.id)) throw httpError(409, 'That person is already on this list.');

    const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
    const existing = db
      .prepare(
        `SELECT id FROM list_invites
         WHERE list_id = ? AND invitee_user_id = ? AND status = 'pending'`
      )
      .get(list.id, invitee.id);

    if (existing) {
      db.prepare('UPDATE list_invites SET role = ?, inviter_user_id = ?, created_at = ? WHERE id = ?').run(
        role,
        user.id,
        nowIso(),
        existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO list_invites (list_id, inviter_user_id, invitee_user_id, role, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      ).run(list.id, user.id, invitee.id, role, nowIso());
    }

    res.status(201).json({ ok: true });
  })
);

app.get(
  '/api/share/:token',
  route((req, res) => {
    const list = db.prepare('SELECT * FROM lists WHERE share_token = ?').get(req.params.token);
    if (!list) throw httpError(404, 'Shared list not found.');
    sendListPayload(req, res, list, req.user, true);
  })
);

app.post(
  '/api/invites/:token/join',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'invite-join');
    const list = db.prepare('SELECT * FROM lists WHERE invite_token = ? AND kind = ?').get(req.params.token, 'collab');
    if (!list) throw httpError(404, 'Invite link not found.');
    db.prepare(
      `INSERT OR IGNORE INTO list_members (list_id, user_id, role, joined_at)
       VALUES (?, ?, 'editor', ?)`
    ).run(list.id, user.id, nowIso());
    res.json(buildListPayload(list, user));
  })
);

app.post(
  '/api/lists/:id/albums',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'album-write');
    const list = getListOrThrow(Number(req.params.id));
    assertCanEdit(list, user);
    const title = clampText(req.body?.title, 160);
    if (!title) throw httpError(400, 'Album title is required.');
    const artist = clampText(req.body?.artist, 160);
    const existing = findAlbumInList(list.id, title, artist);
    if (existing) {
      updateExistingAlbumFromInput(existing, req.body, list.id);
      queueAlbumHydrationJobs({ ...req.body, title, artist }, { priority: 15, sourceContext: 'list-add' });
      res.json({
        copied: false,
        albumId: existing.id,
        ...buildListMutationResponse(getListOrThrow(list.id), user, {
          albumId: existing.id,
          includeListSummary: true
        })
      });
      return;
    }
    const albumId = transaction(() => {
      const id = insertAlbum(list.id, user.id, req.body);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), list.id);
      return id;
    })();
    res.status(201).json({
      albumId,
      ...buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId,
        includeListSummary: true
      })
    });
  })
);

app.post(
  '/api/lists/:id/albums/copy',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'album-write');
    const list = getListOrThrow(Number(req.params.id));
    assertCanEdit(list, user);
    const albumInput = req.body || {};
    const title = clampText(albumInput?.title, 160);
    if (!title) throw httpError(400, 'Album title is required.');
    const artist = clampText(albumInput?.artist, 160);
    const existing = findAlbumInList(list.id, title, artist);
    if (existing) {
      updateExistingAlbumFromInput(existing, albumInput, list.id);
      queueAlbumHydrationJobs(albumInput, { priority: 15, sourceContext: 'list-copy' });
      res.json({
        copied: false,
        albumId: existing.id,
        ...buildListMutationResponse(getListOrThrow(list.id), user, {
          albumId: existing.id,
          includeListSummary: true
        })
      });
      return;
    }

    const albumId = transaction(() => {
      const id = insertAlbum(list.id, user.id, albumInput);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), list.id);
      return id;
    })();
    res.status(201).json({
      copied: true,
      albumId,
      ...buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId,
        includeListSummary: true
      })
    });
  })
);

app.post(
  '/api/lists/:id/albums/:albumId/cover/refresh',
  route(async (req, res) => {
    const user = requireUser(req);
    const list = getListOrThrow(Number(req.params.id));
    assertCanEdit(list, user);
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');
    limitCoverRefresh(req, album.id);
    limitAlbumLookup(req);
    limitDbWrite(req, 'cover-refresh');

    const force = req.body?.force === true;
    const currentCoverUrl = safeExternalImageUrl(album.cover_url);
    const excludedCoverUrls = safeCoverUrlList([req.body?.brokenUrl, force ? currentCoverUrl : '']);
    if (force) clearAlbumCoverLookupFailure(album.album_key);
    const currentStillWorks = !force && currentCoverUrl ? await imageUrlWorks(currentCoverUrl) : false;
    if (!currentStillWorks && currentCoverUrl) excludedCoverUrls.push(currentCoverUrl);
    const refreshedCoverUrl = currentStillWorks
      ? currentCoverUrl
      : await resolveVerifiedAlbumCover(album.title, album.artist, itunesCountry(req), excludedCoverUrls);
    let nextCoverUrl = refreshedCoverUrl || (currentStillWorks ? currentCoverUrl : '');

    transaction(() => {
      db.prepare('UPDATE list_albums SET cover_url = ?, updated_at = ? WHERE id = ? AND list_id = ?').run(
        nextCoverUrl,
        nowIso(),
        album.id,
        list.id
      );
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), list.id);
    })();
    if (refreshedCoverUrl) {
      repairAlbumCoverReferences(album.title, album.artist, refreshedCoverUrl, excludedCoverUrls, 'cover-refresh');
      const localCover = await cacheLocalCoverForAlbum({ title: album.title, artist: album.artist, coverUrl: refreshedCoverUrl }, 'cover-refresh');
      if (localCover?.publicPath) nextCoverUrl = localCover.publicPath;
    } else if (!currentStillWorks) {
      recordAlbumCoverLookupFailure(album.title, album.artist, 'manual-refresh', 'No working cover found.');
    }

    res.json({
      coverUrl: nextCoverUrl,
      ...buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: album.id,
        includeListSummary: true
      })
    });
  })
);

app.post(
  '/api/lists/:id/messages',
  route((req, res) => {
    const user = requireUser(req);
    limitChatMessage(req);
    const list = getListOrThrow(Number(req.params.id));
    const member = assertCanView(list, user);
    if (!member) throw httpError(403, 'Only list members can chat.');
    if (list.kind !== 'collab') throw httpError(400, 'Only collaborative lists have chat.');
    const body = clampText(req.body?.body, 800);
    if (!body) throw httpError(400, 'Message cannot be empty.');
    db.prepare('INSERT INTO list_messages (list_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(
      list.id,
      user.id,
      body,
      nowIso()
    );
    res.status(201).json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.patch(
  '/api/lists/:id/albums/:albumId',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'album-write');
    const list = getListOrThrow(Number(req.params.id));
    assertCanEdit(list, user);
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');

    const title = req.body?.title === undefined ? album.title : clampText(req.body.title, 160);
    if (!title) throw httpError(400, 'Album title is required.');
    const artist = req.body?.artist === undefined ? album.artist : clampText(req.body.artist, 160);
    const coverUrl = req.body?.coverUrl === undefined ? album.cover_url : validateCoverUrl(req.body.coverUrl);
    const notes = req.body?.notes === undefined ? album.notes : clampText(req.body.notes, 1200);
    const key = albumKey(title, artist);

    transaction(() => {
      db.prepare(
        `UPDATE list_albums
         SET title = ?, artist = ?, album_key = ?, cover_url = ?, notes = ?, updated_at = ?
         WHERE id = ? AND list_id = ?`
      ).run(title, artist, key, coverUrl, notes, nowIso(), album.id, list.id);
      if (Array.isArray(req.body?.tracks)) replaceAlbumTracks(album.id, req.body.tracks);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), list.id);
    })();

    res.json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.delete(
  '/api/lists/:id/albums/by-key',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'album-write');
    const list = getListOrThrow(Number(req.params.id));
    assertCanView(list, user);
    const title = clampText(req.body?.title, 160);
    if (!title) throw httpError(400, 'Album title is required.');
    const artist = clampText(req.body?.artist, 160);
    const album = findAlbumInList(list.id, title, artist);
    if (!album) {
      res.json({
        removed: false,
        albumId: null,
        ...buildListMutationResponse(getListOrThrow(list.id), user, {
          includeListSummary: true
        })
      });
      return;
    }

    const result = removeListAlbum(list, user, album);
    res.json({
      ...result,
      ...buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: result.removed ? null : album.id,
        includeListSummary: true,
        removedAlbumId: result.removed ? result.albumId : null
      })
    });
  })
);

app.delete(
  '/api/lists/:id/albums/:albumId',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'album-write');
    const list = getListOrThrow(Number(req.params.id));
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');

    const result = removeListAlbum(list, user, album);
    res.json({
      ...result,
      ...buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: result.removed ? null : album.id,
        includeListSummary: true,
        removedAlbumId: result.removed ? result.albumId : null
      })
    });
  })
);

app.post(
  '/api/lists/:id/albums/:albumId/complete',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'completion-write');
    const list = getListOrThrow(Number(req.params.id));
    const member = assertCanView(list, user);
    if (!member) throw httpError(403, 'Only list members can mark albums complete.');
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');

    if (req.body?.completed === false) {
      db.prepare('DELETE FROM album_completions WHERE list_album_id = ? AND user_id = ?').run(album.id, user.id);
      db.prepare('UPDATE user_album_activity SET completed_at = NULL, updated_at = ? WHERE user_id = ? AND album_key = ?').run(
        nowIso(),
        user.id,
        album.album_key
      );
    } else {
      const completedAt = nowIso();
      db.prepare(
        `INSERT INTO album_completions (list_album_id, user_id, completed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(list_album_id, user_id) DO UPDATE SET completed_at = excluded.completed_at`
      ).run(album.id, user.id, completedAt);
      upsertUserAlbumActivity(user.id, album, { completedAt });
    }

    res.json(
      buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: album.id
      })
    );
  })
);

app.patch(
  '/api/lists/:id/albums/:albumId/rating-preferences',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const list = getListOrThrow(Number(req.params.id));
    const member = assertCanView(list, user);
    if (!member) throw httpError(403, 'Only list members can rate albums.');
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');
    const include = req.body?.includeInAverage === false ? 0 : 1;
    db.prepare(
      `INSERT INTO album_average_opt_in (user_id, album_key, include_in_average, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, album_key) DO UPDATE
       SET include_in_average = excluded.include_in_average, updated_at = excluded.updated_at`
    ).run(user.id, album.album_key, include, nowIso());
    res.json(
      buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: album.id
      })
    );
  })
);

app.put(
  '/api/lists/:id/albums/:albumId/rating',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const list = getListOrThrow(Number(req.params.id));
    const member = assertCanView(list, user);
    if (!member) throw httpError(403, 'Only list members can rate albums.');
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
      throw httpError(400, 'Rating must be a whole number from 0 to 10.');
    }
    const existingRating = db
      .prepare('SELECT include_in_average FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?')
      .get(user.id, album.album_key, albumLevelTrackKey);
    const include =
      req.body?.includeInAverage === undefined ? existingRating?.include_in_average ?? 1 : req.body.includeInAverage === false ? 0 : 1;

    transaction(() => {
      const ratedAt = nowIso();
      db.prepare(
        `INSERT INTO track_ratings (user_id, album_key, track_key, track_title, rating, include_in_average, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, album_key, track_key) DO UPDATE
         SET track_title = excluded.track_title,
             rating = excluded.rating,
             include_in_average = excluded.include_in_average,
             updated_at = excluded.updated_at`
      ).run(user.id, album.album_key, albumLevelTrackKey, 'Album rating', rating, include, ratedAt);
      upsertUserAlbumActivity(user.id, album, {
        ratedAt,
        completedAt: userAlbumFullyListened(user.id, album.album_key) ? ratedAt : undefined
      });
    })();

    res.json(
      buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: album.id
      })
    );
  })
);

app.put(
  '/api/lists/:id/albums/:albumId/tracks/:trackId/rating',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const list = getListOrThrow(Number(req.params.id));
    const member = assertCanView(list, user);
    if (!member) throw httpError(403, 'Only list members can rate tracks.');
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');
    const track = db.prepare('SELECT * FROM album_tracks WHERE id = ? AND list_album_id = ?').get(Number(req.params.trackId), album.id);
    if (!track) throw httpError(404, 'Track not found.');

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
      throw httpError(400, 'Rating must be a whole number from 0 to 10.');
    }
    const existingRating = db
      .prepare('SELECT include_in_average FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?')
      .get(user.id, album.album_key, track.track_key);
    const include =
      req.body?.includeInAverage === undefined ? existingRating?.include_in_average ?? 1 : req.body.includeInAverage === false ? 0 : 1;

    transaction(() => {
      const ratedAt = nowIso();
      db.prepare(
        `INSERT INTO track_ratings (user_id, album_key, track_key, track_title, rating, include_in_average, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, album_key, track_key) DO UPDATE
         SET track_title = excluded.track_title,
             rating = excluded.rating,
             include_in_average = excluded.include_in_average,
             updated_at = excluded.updated_at`
      ).run(user.id, album.album_key, track.track_key, track.title, rating, include, ratedAt);
      upsertUserAlbumActivity(user.id, album, { ratedAt });
      maybeAutoCompleteAlbum(list, album, user.id);
    })();

    res.json(
      buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: album.id
      })
    );
  })
);

app.patch(
  '/api/lists/:id/albums/:albumId/tracks/:trackId/rating-preferences',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const list = getListOrThrow(Number(req.params.id));
    const member = assertCanView(list, user);
    if (!member) throw httpError(403, 'Only list members can rate tracks.');
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');
    const track = db.prepare('SELECT * FROM album_tracks WHERE id = ? AND list_album_id = ?').get(Number(req.params.trackId), album.id);
    if (!track) throw httpError(404, 'Track not found.');

    const existingRating = db
      .prepare('SELECT id FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?')
      .get(user.id, album.album_key, track.track_key);
    if (!existingRating) throw httpError(400, 'Rate this track before excluding it from album ratings.');

    const include = req.body?.includeInAverage === false ? 0 : 1;
    db.prepare(
      `UPDATE track_ratings
       SET include_in_average = ?, updated_at = ?
       WHERE id = ?`
    ).run(include, nowIso(), existingRating.id);

    res.json(
      buildListMutationResponse(getListOrThrow(list.id), user, {
        albumId: album.id
      })
    );
  })
);

app.delete(
  '/api/lists/:id/albums/:albumId/tracks/:trackId/rating',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'rating-write');
    const list = getListOrThrow(Number(req.params.id));
    const member = assertCanView(list, user);
    if (!member) throw httpError(403, 'Only list members can rate tracks.');
    const album = db.prepare('SELECT * FROM list_albums WHERE id = ? AND list_id = ?').get(Number(req.params.albumId), list.id);
    if (!album) throw httpError(404, 'Album not found.');
    const track = db.prepare('SELECT * FROM album_tracks WHERE id = ? AND list_album_id = ?').get(Number(req.params.trackId), album.id);
    if (!track) throw httpError(404, 'Track not found.');
    db.prepare('DELETE FROM track_ratings WHERE user_id = ? AND album_key = ? AND track_key = ?').run(user.id, album.album_key, track.track_key);
    res.json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.patch(
  '/api/lists/:id/members/:userId',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'member-write');
    const list = getListOrThrow(Number(req.params.id));
    assertCanManage(list, user);
    const targetUserId = Number(req.params.userId);
    if (targetUserId === list.owner_user_id) throw httpError(400, 'The owner role cannot be changed.');
    if (!['editor', 'viewer'].includes(req.body?.role)) throw httpError(400, 'Role must be editor or viewer.');
    db.prepare('UPDATE list_members SET role = ? WHERE list_id = ? AND user_id = ?').run(req.body.role, list.id, targetUserId);
    res.json(buildListPayload(getListOrThrow(list.id), user));
  })
);

app.delete(
  '/api/lists/:id/members/:userId',
  route((req, res) => {
    const user = requireUser(req);
    limitDbWrite(req, 'member-write');
    const list = getListOrThrow(Number(req.params.id));
    if (list.kind !== 'collab') throw httpError(400, 'Only shared lists have removable members.');
    const targetUserId = Number(req.params.userId);
    const removingSelf = targetUserId === user.id;
    if (removingSelf) assertCanView(list, user);
    else assertCanManage(list, user);
    const removingOwner = targetUserId === list.owner_user_id;
    if (removingOwner && !removingSelf) throw httpError(400, 'The owner cannot be removed by another member.');
    if (!getMember(list.id, targetUserId)) throw httpError(404, 'Member not found.');

    let listDeleted = false;
    transaction(() => {
      if (removingOwner) {
        const nextOwner = db
          .prepare(
            `SELECT user_id
             FROM list_members
             WHERE list_id = ? AND user_id != ?
             ORDER BY role = 'editor' DESC, joined_at ASC, user_id ASC
             LIMIT 1`
          )
          .get(list.id, targetUserId);

        if (!nextOwner) {
          db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
          listDeleted = true;
          return;
        }

        db.prepare('UPDATE lists SET owner_user_id = ?, updated_at = ? WHERE id = ?').run(nextOwner.user_id, nowIso(), list.id);
        db.prepare('UPDATE list_members SET role = ? WHERE list_id = ? AND user_id = ?').run('owner', list.id, nextOwner.user_id);
      }

      db.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(list.id, targetUserId);
      db.prepare(
        `DELETE FROM list_album_removal_votes
         WHERE user_id = ?
           AND list_album_id IN (SELECT id FROM list_albums WHERE list_id = ?)`
      ).run(targetUserId, list.id);
      if (!removingOwner) db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), list.id);
    })();

    const payload = removingSelf || listDeleted ? null : buildListPayload(getListOrThrow(list.id), user);
    res.json({ ok: true, lists: getUserLists(user.id), list: payload });
  })
);

app.get(
  '/api/history/:token',
  route((req, res) => {
    const owner = db.prepare('SELECT * FROM users WHERE history_token = ?').get(req.params.token);
    if (!owner || owner.history_visibility !== 'unlisted') throw httpError(404, 'History not found.');

    const completions = db
      .prepare(
        `WITH activity_completed AS (
           SELECT completed_at, album_key, title, artist, cover_url, '' AS list_name
           FROM user_album_activity
           WHERE user_id = ? AND completed_at IS NOT NULL
         ),
         legacy_completed AS (
           SELECT MAX(ac.completed_at) AS completed_at, la.album_key, MAX(la.title) AS title,
                  MAX(la.artist) AS artist, MAX(la.cover_url) AS cover_url, MAX(l.name) AS list_name
           FROM album_completions ac
           JOIN list_albums la ON la.id = ac.list_album_id
           JOIN lists l ON l.id = la.list_id
           WHERE ac.user_id = ?
             AND NOT EXISTS (
               SELECT 1
               FROM user_album_activity activity
               WHERE activity.user_id = ac.user_id
                 AND activity.album_key = la.album_key
                 AND activity.completed_at IS NOT NULL
             )
           GROUP BY la.album_key
         )
         SELECT * FROM activity_completed
         UNION ALL
         SELECT * FROM legacy_completed
         ORDER BY completed_at DESC
         LIMIT 200`
      )
      .all(owner.id, owner.id)
      .map((completion) => {
        const metadata = albumMetadata(completion.album_key);
        return {
          completedAt: completion.completed_at,
          albumKey: completion.album_key,
          title: completion.title || metadata.title,
          artist: completion.artist || metadata.artist || '',
          coverUrl: safeExternalImageUrl(completion.cover_url) || safeExternalImageUrl(metadata.cover_url),
          listName: completion.list_name,
          aggregate: albumRatingAggregate(completion.album_key),
          myRatings: db
            .prepare(
              `WITH track_order AS (
                 SELECT at.track_key,
                        MIN(at.disc_number) AS disc_number,
                        MIN(at.position) AS position,
                        MIN(at.id) AS stable_id
                 FROM album_tracks at
                 JOIN list_albums la ON la.id = at.list_album_id
                 WHERE la.album_key = ?
                 GROUP BY at.track_key
               )
               SELECT r.track_key, r.track_title, r.rating, r.include_in_average, r.updated_at
               FROM track_ratings r
               LEFT JOIN track_order ord ON ord.track_key = r.track_key
               WHERE r.user_id = ? AND r.album_key = ?
               ORDER BY r.track_key = ? DESC,
                        COALESCE(ord.disc_number, 999),
                        COALESCE(ord.position, 9999),
                        COALESCE(ord.stable_id, r.id),
                        r.track_title COLLATE NOCASE,
                        r.track_key`
            )
            .all(completion.album_key, owner.id, completion.album_key, albumLevelTrackKey)
            .map((rating) => ({
              trackKey: rating.track_key,
              trackTitle: rating.track_title,
              rating: rating.rating,
              includeInAverage: Boolean(rating.include_in_average),
              updatedAt: rating.updated_at
            }))
        };
      });

    res.json({ user: publicUser(owner), completions });
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: { message: 'Not found.', status: 404 } });
});

app.use('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).type('text/plain').send('Not found.');
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
  }
  if (err.retryAfter) {
    res.setHeader('Retry-After', String(err.retryAfter));
  }
  res.status(status).json({
    error: {
      message: status >= 500 ? 'Something went wrong.' : err.message,
      status
    }
  });
});

cleanupExpiredSessions();

try {
  const persistentPruned = prunePersistentCacheRows();
  if (
    persistentPruned.searchCache.expired ||
    persistentPruned.searchCache.overflow ||
    persistentPruned.coverProbeCache.expired ||
    persistentPruned.coverProbeCache.overflow ||
    persistentPruned.metadataJobsDeleted
  ) {
    console.log(JSON.stringify({ event: 'persistent_cache_pruned', ...persistentPruned }));
  }
  const pruned = pruneLocalCoverCache();
  if (pruned.evictedCount) {
    console.log(JSON.stringify({ event: 'local_cover_cache_pruned', evictedCount: pruned.evictedCount }));
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'local_cover_cache_prune_failure', error: String(error?.message || error) }));
}

const metadataWorker = createMetadataWorker({
  handlers: {
    album_metadata: hydrateAlbumMetadataJob,
    cover: hydrateCoverJob,
    tracklist: hydrateTracklistJob,
    explore_cover: hydrateCoverJob
  }
});

const server = app.listen(config.port, () => {
  console.log(`Albums app listening on http://localhost:${config.port}`);
  metadataWorker.start();
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Closing HTTP server and SQLite database.`);
  server.close((error) => {
    (async () => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
      try {
        await metadataWorker.stop();
      } catch (workerError) {
        console.error(workerError);
        process.exitCode = 1;
      }
      try {
        closeDatabase();
      } catch (closeError) {
        console.error(closeError);
        process.exitCode = 1;
      }
      process.exit();
    })();
  });

  setTimeout(() => {
    console.error('Shutdown timed out.');
    process.exit(1);
  }, 20_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
