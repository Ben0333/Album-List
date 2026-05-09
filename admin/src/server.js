import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(repoRoot, '.env'), override: false });
dotenv.config();
dotenv.config({ path: path.join(repoRoot, '.env.admin'), override: false });
dotenv.config({ path: path.resolve(process.cwd(), '.env.admin'), override: false });

const { albumKey, closeDatabase, db, nowIso, transaction } = await import('@albums/shared/db');
const { config } = await import('@albums/shared/config');

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const reportStatuses = new Set(['open', 'in_progress', 'fixed', 'wont_fix']);
const reportPriorities = new Set(['low', 'medium', 'high', 'critical']);
const adminSessions = new Map();
const rateLimitBuckets = new Map();
const activeVisitorWindowMs = 120 * 1000;
const activeVisitorRetentionMs = 10 * 60 * 1000;
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

function fileSize(pathname) {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}

function storageUsage() {
  const databasePath = config.databasePath;
  const database = {
    path: databasePath,
    mainBytes: fileSize(databasePath),
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`)
  };
  database.totalBytes = database.mainBytes + database.walBytes + database.shmBytes;
  database.totalLabel = formatBytes(database.totalBytes);

  let disk = null;
  if (typeof fs.statfsSync === 'function') {
    try {
      const stats = fs.statfsSync(path.dirname(databasePath));
      const blockSize = Number(stats.bsize || 0);
      const totalBytes = Number(stats.blocks || 0) * blockSize;
      const freeBytes = Number(stats.bavail || stats.bfree || 0) * blockSize;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      if (totalBytes > 0) {
        disk = {
          usedBytes,
          freeBytes,
          totalBytes,
          percentUsed: Math.round((usedBytes / totalBytes) * 1000) / 10,
          usedLabel: formatBytes(usedBytes),
          freeLabel: formatBytes(freeBytes),
          totalLabel: formatBytes(totalBytes)
        };
      }
    } catch {
      disk = null;
    }
  }

  return {
    disk,
    database,
    fallback: !disk,
    note: disk
      ? ''
      : 'Exact disk capacity is not available in this runtime; showing SQLite database file usage only.'
  };
}

function cleanupActiveVisitors() {
  const cutoff = new Date(Date.now() - activeVisitorRetentionMs).toISOString();
  db.prepare('DELETE FROM active_visitors WHERE last_seen_at < ?').run(cutoff);
}

function activeVisitorSummary() {
  cleanupActiveVisitors();
  const cutoff = new Date(Date.now() - activeVisitorWindowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS anonymous,
              COUNT(DISTINCT CASE WHEN user_id IS NOT NULL THEN user_id END) AS logged_in_users
       FROM active_visitors
       WHERE last_seen_at >= ?`
    )
    .get(cutoff);
  return {
    total: Number(row?.total || 0),
    anonymous: Number(row?.anonymous || 0),
    loggedInUsers: Number(row?.logged_in_users || 0),
    windowSeconds: Math.round(activeVisitorWindowMs / 1000)
  };
}

function settingValue(key, fallback = '') {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? fallback;
}

function setSettingValue(key, value, description = '') {
  db.prepare(
    `INSERT INTO app_settings (key, value, description, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       description = CASE WHEN excluded.description != '' THEN excluded.description ELSE app_settings.description END,
       updated_at = excluded.updated_at`
  ).run(key, value, description, nowIso());
}

function maintenanceMode() {
  return settingValue('maintenance_mode', '0') === '1';
}

function sqliteStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createDatabaseBackup() {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'albums-db-backup-'));
  const fileName = `albums-${backupTimestamp()}.sqlite`;
  const filePath = path.join(backupDir, fileName);

  try {
    db.exec(`VACUUM main INTO ${sqliteStringLiteral(filePath)}`);
    const sizeBytes = fs.statSync(filePath).size;
    return {
      fileName,
      filePath,
      sizeBytes,
      cleanup() {
        fs.rm(backupDir, { recursive: true, force: true }, (error) => {
          if (error) console.error(error);
        });
      }
    };
  } catch (error) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

function logAdminAction(action, { userId = null, previousUsername = '', newUsername = '', details = {} } = {}) {
  db.prepare(
    `INSERT INTO admin_action_log (action, user_id, previous_username, new_username, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(action, userId, previousUsername, newUsername, JSON.stringify(details), nowIso());
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
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    notes: row.notes || '',
    source: row.source || '',
    userId: row.user_id || null,
    username: row.reporter_username || row.username || null,
    email: row.email || null,
    pagePath: row.page_path || '',
    browser: row.browser || '',
    userAgent: row.user_agent || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
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

function slugBase(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return slug || `explore-${randomToken(5).toLowerCase()}`;
}

function uniqueExploreSlug(name, existingId = null) {
  const base = slugBase(name);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const row = db.prepare('SELECT id FROM explore_playlists WHERE slug = ?').get(slug);
    if (!row || row.id === existingId) return slug;
  }
  return `${base}-${randomToken(5).toLowerCase()}`;
}

function shareTokenFromLink(value) {
  const text = clampText(value, 1000);
  if (!text) throw httpError(400, 'Share link is required.');
  let token = '';
  try {
    const url = new URL(text);
    const parts = url.pathname.split('/').filter(Boolean);
    const shareIndex = parts.indexOf('share');
    token = shareIndex >= 0 ? parts[shareIndex + 1] || '' : '';
  } catch {
    const parts = text.split('/').filter(Boolean);
    const shareIndex = parts.indexOf('share');
    token = shareIndex >= 0 ? parts[shareIndex + 1] || '' : text;
  }

  try {
    token = decodeURIComponent(token);
  } catch {
    token = '';
  }

  token = token.trim();
  if (!/^[a-zA-Z0-9_-]{12,120}$/.test(token)) {
    throw httpError(400, 'Share link must be a valid Turntable /share/... link or share token.');
  }
  return token;
}

function sharedListForLink(shareLink) {
  const token = shareTokenFromLink(shareLink);
  const list = db
    .prepare(
      `SELECT l.*, u.username AS owner_username
       FROM lists l
       JOIN users u ON u.id = l.owner_user_id
       WHERE l.share_token = ?`
    )
    .get(token);
  if (!list) throw httpError(404, 'No shared list was found for that link.');
  const albums = db
    .prepare(
      `SELECT la.*, u.username AS added_by_username
       FROM list_albums la
       LEFT JOIN users u ON u.id = la.created_by
       WHERE la.list_id = ?
       ORDER BY la.sort_order ASC, la.id ASC`
    )
    .all(list.id);
  if (!albums.length) throw httpError(400, 'That shared list has no albums to import.');
  return { list, albums };
}

function safeExplorePlaylist(row, options = {}) {
  const playlist = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    shareLink: row.share_link || '',
    sourceListId: row.source_list_id || null,
    sourceListName: row.source_list_name || '',
    sourceOwnerUserId: row.source_owner_user_id || null,
    sourceOwnerUsername: row.source_owner_username || '',
    visible: Boolean(row.visible),
    sortOrder: Number(row.sort_order || 0),
    albumCount: Number(row.album_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    importedAt: row.imported_at || null
  };
  if (options.includeAlbums) {
    playlist.albums = db
      .prepare(
        `SELECT id, sort_order, title, artist, album_key, cover_url, release_year, source_list_album_id, source_added_by_username
         FROM explore_playlist_albums
         WHERE playlist_id = ?
         ORDER BY sort_order ASC, id ASC`
      )
      .all(row.id)
      .map((album) => ({
        id: album.id,
        sortOrder: Number(album.sort_order || 0),
        title: album.title,
        artist: album.artist || '',
        albumKey: album.album_key,
        coverUrl: album.cover_url || '',
        releaseYear: album.release_year ?? null,
        sourceListAlbumId: album.source_list_album_id || null,
        sourceAddedByUsername: album.source_added_by_username || ''
      }));
  }
  return playlist;
}

function getExplorePlaylist(id) {
  const row = db.prepare('SELECT * FROM explore_playlists WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'Explore playlist not found.');
  return row;
}

function replaceExplorePlaylistAlbums(playlistId, albums) {
  db.prepare('DELETE FROM explore_playlist_albums WHERE playlist_id = ?').run(playlistId);
  const insertAlbum = db.prepare(
    `INSERT INTO explore_playlist_albums
     (playlist_id, sort_order, title, artist, album_key, cover_url, release_year, source_list_album_id, source_added_by_user_id, source_added_by_username, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let count = 0;
  for (const [index, album] of albums.entries()) {
    const title = clampText(album.title, 160);
    if (!title) continue;
    const artist = clampText(album.artist, 160);
    insertAlbum.run(
      playlistId,
      index + 1,
      title,
      artist,
      album.album_key || albumKey(title, artist),
      clampText(album.cover_url, 700),
      album.release_year ?? null,
      album.id || null,
      album.created_by || null,
      album.added_by_username || '',
      nowIso()
    );
    count += 1;
  }
  db.prepare('UPDATE explore_playlists SET album_count = ?, updated_at = ?, imported_at = ? WHERE id = ?').run(
    count,
    nowIso(),
    nowIso(),
    playlistId
  );
  return count;
}

function createExplorePlaylistFromShare(body) {
  const shareLink = clampText(body?.shareLink ?? body?.share_link, 1000);
  const source = sharedListForLink(shareLink);
  const name = clampText(body?.name, 120) || source.list.name;
  const description = clampText(body?.description, 1200) || source.list.description || `Imported from ${source.list.name}.`;
  const visible = body?.visible === false ? 0 : 1;
  const sortOrder = parseBoundedInteger(body?.sortOrder ?? body?.sort_order, 0, { min: -100_000, max: 100_000 });

  const playlist = transaction(() => {
    const createdAt = nowIso();
    const info = db
      .prepare(
        `INSERT INTO explore_playlists
         (slug, name, description, share_link, source_list_id, source_list_name, source_owner_user_id, source_owner_username,
          visible, sort_order, album_count, created_at, updated_at, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        uniqueExploreSlug(name),
        name,
        description,
        shareLink,
        source.list.id,
        source.list.name,
        source.list.owner_user_id,
        source.list.owner_username || '',
        visible,
        sortOrder,
        createdAt,
        createdAt,
        createdAt
      );
    const playlistId = Number(info.lastInsertRowid);
    const albumCount = replaceExplorePlaylistAlbums(playlistId, source.albums);
    logAdminAction('explore_playlist_create', {
      details: {
        playlistId,
        name,
        sourceListId: source.list.id,
        albumCount
      }
    });
    return getExplorePlaylist(playlistId);
  })();

  return safeExplorePlaylist(playlist, { includeAlbums: true });
}

function updateExplorePlaylistFromBody(playlistId, body, { forceImport = false } = {}) {
  const updated = transaction(() => {
    const existing = getExplorePlaylist(playlistId);
    const nextName = body?.name === undefined ? existing.name : clampText(body.name, 120);
    if (!nextName) throw httpError(400, 'Playlist name is required.');
    const nextDescription = body?.description === undefined ? existing.description || '' : clampText(body.description, 1200);
    const nextVisible = body?.visible === undefined ? existing.visible : body.visible === false ? 0 : 1;
    const nextSortOrder =
      body?.sortOrder === undefined && body?.sort_order === undefined
        ? existing.sort_order
        : parseBoundedInteger(body?.sortOrder ?? body?.sort_order, existing.sort_order, { min: -100_000, max: 100_000 });
    const nextShareLink =
      body?.shareLink === undefined && body?.share_link === undefined ? existing.share_link || '' : clampText(body?.shareLink ?? body?.share_link, 1000);

    let source = null;
    if (forceImport || nextShareLink !== (existing.share_link || '')) {
      source = sharedListForLink(nextShareLink);
    }

    db.prepare(
      `UPDATE explore_playlists
       SET name = ?,
           description = ?,
           share_link = ?,
           source_list_id = ?,
           source_list_name = ?,
           source_owner_user_id = ?,
           source_owner_username = ?,
           visible = ?,
           sort_order = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      nextName,
      nextDescription,
      nextShareLink,
      source ? source.list.id : existing.source_list_id,
      source ? source.list.name : existing.source_list_name || '',
      source ? source.list.owner_user_id : existing.source_owner_user_id,
      source ? source.list.owner_username || '' : existing.source_owner_username || '',
      nextVisible,
      nextSortOrder,
      nowIso(),
      playlistId
    );

    let imported = false;
    let albumCount = existing.album_count;
    if (source) {
      albumCount = replaceExplorePlaylistAlbums(playlistId, source.albums);
      imported = true;
      logAdminAction('explore_playlist_import', {
        details: {
          playlistId,
          sourceListId: source.list.id,
          albumCount
        }
      });
    }

    logAdminAction('explore_playlist_update', {
      details: {
        playlistId,
        name: nextName,
        visible: Boolean(nextVisible),
        sortOrder: nextSortOrder,
        imported,
        albumCount
      }
    });

    return getExplorePlaylist(playlistId);
  })();

  return safeExplorePlaylist(updated, { includeAlbums: true });
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

app.get('/admin/*', (req, res, next) => {
  if (req.path.startsWith('/admin/api')) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(adminPublicDir, 'index.html'));
});

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

app.post(
  '/admin/api/database/backup',
  route((req, res, next) => {
    enforceRateLimit(req, 'database-backup', {
      limit: 6,
      windowMs: 60 * 60 * 1000,
      message: 'Database backups are temporarily rate limited. Try again later.'
    });

    let backup;
    try {
      backup = createDatabaseBackup();
      logAdminAction('database_backup', {
        details: {
          fileName: backup.fileName,
          sizeBytes: backup.sizeBytes,
          authKind: req.adminAuth?.kind || 'unknown'
        }
      });
    } catch (error) {
      if (backup) backup.cleanup();
      console.error(error);
      const backupError = httpError(500, 'Could not create a database backup. Check that the database path is writable and try again.');
      backupError.expose = true;
      throw backupError;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Length', String(backup.sizeBytes));
    res.download(backup.filePath, backup.fileName, (error) => {
      backup.cleanup();
      if (!error) return;
      if (res.headersSent) {
        console.error(error);
        return;
      }
      next(error);
    });
  })
);

app.get(
  '/admin/api/summary',
  route((req, res) => {
    const activeAt = nowIso();
    const visitors = activeVisitorSummary();
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
        activeVisitors: visitors.total,
        lists: count('lists'),
        albums: count('list_albums'),
        ratings: count('track_ratings'),
        messages: count('list_messages')
      },
      activeVisitors: visitors,
      storage: storageUsage(),
      maintenance: {
        enabled: maintenanceMode()
      },
      bugReportsByStatus,
      recentSignups
    });
  })
);

app.get(
  '/admin/api/settings',
  route((req, res) => {
    res.json({
      maintenance: {
        enabled: maintenanceMode()
      },
      storage: storageUsage(),
      activeVisitors: activeVisitorSummary()
    });
  })
);

app.patch(
  '/admin/api/settings/maintenance',
  route((req, res) => {
    const enabled = req.body?.enabled === true;
    const previous = maintenanceMode();
    setSettingValue(
      'maintenance_mode',
      enabled ? '1' : '0',
      'When set to 1, the public website returns a maintenance page and public API writes are unavailable.'
    );
    logAdminAction('maintenance_update', {
      details: {
        previousEnabled: previous,
        enabled
      }
    });
    res.json({ maintenance: { enabled } });
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
      logAdminAction('disable', {
        userId: user.id,
        previousUsername: user.username,
        newUsername: user.username,
        details: { reason, previousDisabledAt: user.disabled_at || null, previousReason: user.disabled_reason || '' }
      });
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
      logAdminAction('enable', {
        userId: user.id,
        previousUsername: user.username,
        newUsername: user.username,
        details: { previousDisabledAt: user.disabled_at || null, previousReason: user.disabled_reason || '' }
      });
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
    const priority = String(req.query.priority || '').trim().toLowerCase();
    const q = clampText(req.query.q, 120);
    const filters = [];
    const params = [];

    if (status) {
      if (!reportStatuses.has(status)) throw httpError(400, 'Invalid report status.');
      filters.push('br.status = ?');
      params.push(status);
    }
    if (priority) {
      if (!reportPriorities.has(priority)) throw httpError(400, 'Invalid report priority.');
      filters.push('br.priority = ?');
      params.push(priority);
    }
    if (q) {
      const like = `%${escapeLike(q.toLowerCase())}%`;
      filters.push('(LOWER(br.title) LIKE ? ESCAPE ? OR LOWER(br.description) LIKE ? ESCAPE ? OR CAST(br.id AS TEXT) = ?)');
      params.push(like, '\\', like, '\\', /^\d+$/.test(q) ? q : '');
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM bug_reports br ${where}`).get(...params).count;
    const reports = db
      .prepare(
        `SELECT br.*, u.username, u.email
         FROM bug_reports br
         LEFT JOIN users u ON u.id = br.user_id
         ${where}
         ORDER BY
           CASE br.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           CASE br.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'fixed' THEN 2 ELSE 3 END,
           br.updated_at DESC,
           br.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map(safeReport);

    res.json({ reports, total: Number(total || 0), limit, offset });
  })
);

app.post(
  '/admin/api/reports',
  route((req, res) => {
    const title = clampText(req.body?.title, 160);
    const description = clampText(req.body?.description ?? req.body?.body, 4000);
    const status = String(req.body?.status || 'open').trim().toLowerCase();
    const priority = String(req.body?.priority || 'medium').trim().toLowerCase();
    const notes = clampText(req.body?.notes, 4000);

    if (!title) throw httpError(400, 'Bug title is required.');
    if (!description) throw httpError(400, 'Bug details are required.');
    if (!reportStatuses.has(status)) throw httpError(400, 'Invalid report status.');
    if (!reportPriorities.has(priority)) throw httpError(400, 'Invalid report priority.');

    const createdAt = nowIso();
    const info = db
      .prepare(
        `INSERT INTO bug_reports
         (title, description, status, priority, notes, source, page_path, browser, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        description,
        status,
        priority,
        notes,
        clampText(req.body?.pagePath, 300),
        clampText(req.body?.browser, 500),
        clampText(req.body?.userAgent, 500),
        createdAt,
        createdAt
      );

    logAdminAction('bug_create', {
      details: {
        reportId: Number(info.lastInsertRowid),
        title,
        status,
        priority
      }
    });

    const report = db
      .prepare(
        `SELECT br.*, u.username, u.email
         FROM bug_reports br
         LEFT JOIN users u ON u.id = br.user_id
         WHERE br.id = ?`
      )
      .get(Number(info.lastInsertRowid));
    res.status(201).json({ report: safeReport(report) });
  })
);

app.patch(
  '/admin/api/reports/:id',
  route((req, res) => {
    const reportId = parseId(req.params.id, 'Report id');

    const report = transaction(() => {
      const existing = db
        .prepare(
          `SELECT br.*, u.username, u.email
           FROM bug_reports br
           LEFT JOIN users u ON u.id = br.user_id
           WHERE br.id = ?`
        )
        .get(reportId);
      if (!existing) throw httpError(404, 'Report not found.');

      const title = req.body?.title === undefined ? existing.title : clampText(req.body.title, 160);
      const description =
        req.body?.description === undefined ? existing.description : clampText(req.body.description, 4000);
      const status = req.body?.status === undefined ? existing.status : String(req.body.status || '').trim().toLowerCase();
      const priority = req.body?.priority === undefined ? existing.priority : String(req.body.priority || '').trim().toLowerCase();
      const notes = req.body?.notes === undefined ? existing.notes || '' : clampText(req.body.notes, 4000);
      const pagePath = req.body?.pagePath === undefined ? existing.page_path || '' : clampText(req.body.pagePath, 300);
      const browser = req.body?.browser === undefined ? existing.browser || '' : clampText(req.body.browser, 500);

      if (!title) throw httpError(400, 'Bug title is required.');
      if (!description) throw httpError(400, 'Bug details are required.');
      if (!reportStatuses.has(status)) throw httpError(400, 'Invalid report status.');
      if (!reportPriorities.has(priority)) throw httpError(400, 'Invalid report priority.');

      db.prepare(
        `UPDATE bug_reports
         SET title = ?, description = ?, status = ?, priority = ?, notes = ?, page_path = ?, browser = ?, updated_at = ?
         WHERE id = ?`
      ).run(title, description, status, priority, notes, pagePath, browser, nowIso(), reportId);
      logAdminAction(status !== existing.status ? 'report_status' : 'bug_update', {
        userId: existing.user_id || null,
        previousUsername: existing.reporter_username || existing.username || '',
        newUsername: existing.reporter_username || existing.username || '',
        details: {
          reportId,
          previousTitle: existing.title,
          title,
          previousStatus: existing.status,
          status,
          previousPriority: existing.priority,
          priority
        }
      });

      return db
        .prepare(
          `SELECT br.*, u.username, u.email
           FROM bug_reports br
           LEFT JOIN users u ON u.id = br.user_id
           WHERE br.id = ?`
        )
        .get(reportId);
    })();
    res.json({ report: safeReport(report) });
  })
);

app.patch(
  '/admin/api/reports/:id/status',
  route((req, res) => {
    const reportId = parseId(req.params.id, 'Report id');
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!reportStatuses.has(status)) throw httpError(400, 'Invalid report status.');
    req.body = { status };
    req.params.id = String(reportId);
    const existing = db.prepare('SELECT id FROM bug_reports WHERE id = ?').get(reportId);
    if (!existing) throw httpError(404, 'Report not found.');
    db.prepare('UPDATE bug_reports SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), reportId);
    logAdminAction('report_status', { details: { reportId, status } });
    const report = db
      .prepare(
        `SELECT br.*, u.username, u.email
         FROM bug_reports br
         LEFT JOIN users u ON u.id = br.user_id
         WHERE br.id = ?`
      )
      .get(reportId);
    res.json({ report: safeReport(report) });
  })
);

app.delete(
  '/admin/api/reports/:id',
  route((req, res) => {
    const reportId = parseId(req.params.id, 'Report id');
    const existing = db.prepare('SELECT id, title, status, priority FROM bug_reports WHERE id = ?').get(reportId);
    if (!existing) throw httpError(404, 'Report not found.');
    db.prepare('DELETE FROM bug_reports WHERE id = ?').run(reportId);
    logAdminAction('bug_delete', {
      details: {
        reportId,
        title: existing.title,
        status: existing.status,
        priority: existing.priority
      }
    });
    res.json({ ok: true });
  })
);

app.get(
  '/admin/api/explore-playlists',
  route((req, res) => {
    const playlists = db
      .prepare(
        `SELECT *
         FROM explore_playlists
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC`
      )
      .all()
      .map((row) => safeExplorePlaylist(row, { includeAlbums: true }));
    res.json({ playlists });
  })
);

app.post(
  '/admin/api/explore-playlists',
  route((req, res) => {
    const playlist = createExplorePlaylistFromShare(req.body || {});
    res.status(201).json({ playlist });
  })
);

app.patch(
  '/admin/api/explore-playlists/:id',
  route((req, res) => {
    const playlistId = parseId(req.params.id, 'Playlist id');
    const playlist = updateExplorePlaylistFromBody(playlistId, req.body || {});
    res.json({ playlist });
  })
);

app.post(
  '/admin/api/explore-playlists/:id/import',
  route((req, res) => {
    const playlistId = parseId(req.params.id, 'Playlist id');
    const playlist = updateExplorePlaylistFromBody(playlistId, req.body || {}, { forceImport: true });
    res.json({ playlist });
  })
);

app.delete(
  '/admin/api/explore-playlists/:id',
  route((req, res) => {
    const playlistId = parseId(req.params.id, 'Playlist id');
    const existing = getExplorePlaylist(playlistId);
    db.prepare('DELETE FROM explore_playlists WHERE id = ?').run(playlistId);
    logAdminAction('explore_playlist_delete', {
      details: {
        playlistId,
        name: existing.name,
        albumCount: existing.album_count
      }
    });
    res.json({ ok: true });
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
      message: status >= 500 && !err.expose ? 'Something went wrong.' : err.message,
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
