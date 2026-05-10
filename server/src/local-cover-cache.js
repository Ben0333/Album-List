import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { db, nowIso } from '@albums/shared/db';
import { config } from '@albums/shared/config';

const maxCoverDownloadBytes = 25_000_000;
const allowedMimeTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function coverCacheDir() {
  const dir = path.resolve(config.localCoverCacheDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeImageUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 1000) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return '';
    const ipVersion = net.isIP(hostname);
    if (ipVersion === 4) {
      const parts = hostname.split('.').map(Number);
      if (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168)) return '';
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return '';
      if (parts[0] === 169 && parts[1] === 254) return '';
      if (parts[0] === 0) return '';
    }
    if (ipVersion === 6) {
      if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) return '';
    }
    return url.href;
  } catch {
    return '';
  }
}

function mimeTypeFromResponse(response) {
  return String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

function validateImageBytes(bytes, mimeType) {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mimeType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return false;
}

async function readResponseBody(response) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > maxCoverDownloadBytes) {
    throw new Error('Cover image is too large.');
  }

  const reader = response.body?.getReader?.();
  if (!reader) return Buffer.from(await response.arrayBuffer());

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxCoverDownloadBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Cover image is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function publicPathForFile(fileName) {
  return `/media/covers/${fileName}`;
}

export function isLocalCoverPublicPath(value) {
  return /^\/media\/covers\/[a-f0-9]{16,40}-[a-f0-9]{64}\.(jpe?g|png|webp|gif)$/i.test(String(value || '').trim());
}

export function safeCoverPublicPath(value) {
  const text = String(value || '').trim();
  return isLocalCoverPublicPath(text) ? text : '';
}

function localPathFromPublicPath(publicPath) {
  const safePublicPath = safeCoverPublicPath(publicPath);
  if (!safePublicPath) return '';
  const fileName = path.basename(safePublicPath);
  const fullPath = path.resolve(coverCacheDir(), fileName);
  return isPathInside(coverCacheDir(), fullPath) ? fullPath : '';
}

export function localCoverExists(publicPath) {
  const localPath = localPathFromPublicPath(publicPath);
  if (!localPath) return false;
  try {
    return fs.statSync(localPath).isFile();
  } catch {
    return false;
  }
}

export function touchLocalCover(publicPath) {
  const safePublicPath = safeCoverPublicPath(publicPath);
  if (!safePublicPath) return false;
  const touchedAt = nowIso();
  const result = db
    .prepare(
      `UPDATE album_image_cache
       SET last_accessed_at = ?, updated_at = ?
       WHERE public_path = ? AND local_path != ''`
    )
    .run(touchedAt, touchedAt, safePublicPath);
  return Boolean(result.changes);
}

export function cachedLocalCover(albumKeyValue) {
  const row = db
    .prepare(
      `SELECT public_path
       FROM album_image_cache
       WHERE album_key = ? AND public_path != '' AND local_path != ''
       LIMIT 1`
    )
    .get(albumKeyValue);
  const publicPath = safeCoverPublicPath(row?.public_path);
  if (!publicPath || !localCoverExists(publicPath)) return '';
  return publicPath;
}

export function rememberCoverSource(albumKeyValue, sourceUrl) {
  const safeSourceUrl = safeImageUrl(sourceUrl);
  if (!albumKeyValue || !safeSourceUrl) return '';
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO album_image_cache (album_key, source_url, last_accessed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(album_key) DO UPDATE SET
       source_url = CASE
         WHEN excluded.source_url != '' THEN excluded.source_url
         ELSE album_image_cache.source_url
       END,
       updated_at = excluded.updated_at`
  ).run(albumKeyValue, safeSourceUrl, updatedAt, updatedAt, updatedAt);
  return safeSourceUrl;
}

export function coverSourceForAlbum(albumKeyValue) {
  const row = db
    .prepare(
      `SELECT source_url
       FROM album_image_cache
       WHERE album_key = ? AND source_url != ''
       LIMIT 1`
    )
    .get(albumKeyValue);
  return safeImageUrl(row?.source_url);
}

function deleteLocalFile(localPath) {
  const dir = coverCacheDir();
  const resolved = path.resolve(localPath || '');
  if (!isPathInside(dir, resolved)) return;
  try {
    fs.unlinkSync(resolved);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function replaceCoverReferences(oldPublicPath, nextCoverUrl) {
  const safeOldPublicPath = safeCoverPublicPath(oldPublicPath);
  if (!safeOldPublicPath) return;
  const replacement = String(nextCoverUrl || '').trim();
  const updatedAt = nowIso();
  db.prepare('UPDATE album_metadata_cache SET cover_url = ?, updated_at = ? WHERE cover_url = ?').run(replacement, updatedAt, safeOldPublicPath);
  db.prepare('UPDATE album_cover_cache SET cover_url = ?, updated_at = ? WHERE cover_url = ?').run(replacement, updatedAt, safeOldPublicPath);
  db.prepare('UPDATE list_albums SET cover_url = ?, updated_at = ? WHERE cover_url = ?').run(replacement, updatedAt, safeOldPublicPath);
  db.prepare('UPDATE user_album_activity SET cover_url = ?, updated_at = ? WHERE cover_url = ?').run(replacement, updatedAt, safeOldPublicPath);
  db.prepare('UPDATE explore_album_covers SET cover_url = ?, updated_at = ? WHERE cover_url = ?').run(replacement, updatedAt, safeOldPublicPath);
  db.prepare('UPDATE explore_playlist_albums SET cover_url = ? WHERE cover_url = ?').run(replacement, safeOldPublicPath);
}

function applyLocalCoverReferences({ albumKey, title, artist, publicPath }) {
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO album_metadata_cache (album_key, title, artist, cover_url, source, updated_at)
     VALUES (?, ?, ?, ?, 'local-cover-cache', ?)
     ON CONFLICT(album_key) DO UPDATE SET
       title = CASE WHEN album_metadata_cache.title = '' THEN excluded.title ELSE album_metadata_cache.title END,
       artist = CASE WHEN album_metadata_cache.artist = '' THEN excluded.artist ELSE album_metadata_cache.artist END,
       cover_url = excluded.cover_url,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run(albumKey, title, artist, publicPath, updatedAt);

  db.prepare('UPDATE list_albums SET cover_url = ?, updated_at = ? WHERE album_key = ?').run(publicPath, updatedAt, albumKey);
  db.prepare('UPDATE user_album_activity SET cover_url = ?, updated_at = ? WHERE album_key = ?').run(publicPath, updatedAt, albumKey);
  db.prepare('UPDATE explore_playlist_albums SET cover_url = ? WHERE album_key = ?').run(publicPath, albumKey);
  if (title) {
    db.prepare(
      `UPDATE explore_album_covers
       SET cover_url = ?, updated_at = ?
       WHERE title = ? AND artist = ?`
    ).run(publicPath, updatedAt, title, artist || '');
  }
}

export async function downloadAlbumCover({ albumKey, title = '', artist = '', sourceUrl = '' }) {
  const safeSourceUrl = safeImageUrl(sourceUrl);
  if (!albumKey || !safeSourceUrl) return null;

  const existing = cachedLocalCover(albumKey);
  if (existing) {
    touchLocalCover(existing);
    return {
      albumKey,
      sourceUrl: safeSourceUrl,
      publicPath: existing,
      reused: true
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(safeSourceUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        'User-Agent': `AlbumsToListenTo/0.1 (${config.appOrigin})`
      }
    });
    if (!response.ok) throw new Error(`Cover download failed with HTTP ${response.status}.`);
    if (!safeImageUrl(response.url || safeSourceUrl)) throw new Error('Cover download redirected to an unsafe URL.');
    const mimeType = mimeTypeFromResponse(response);
    const extension = allowedMimeTypes.get(mimeType);
    if (!extension) throw new Error('Cover image type is not supported.');
    const bytes = await readResponseBody(response);
    if (!bytes.length || !validateImageBytes(bytes, mimeType)) throw new Error('Cover image bytes did not match the declared image type.');

    const contentHash = sha256(bytes);
    const fileName = `${sha1(albumKey).slice(0, 16)}-${contentHash}.${extension}`;
    const localPath = path.resolve(coverCacheDir(), fileName);
    if (!isPathInside(coverCacheDir(), localPath)) throw new Error('Cover cache path escaped the cache directory.');
    fs.writeFileSync(localPath, bytes, { flag: 'w' });

    const previous = db.prepare('SELECT local_path, public_path FROM album_image_cache WHERE album_key = ?').get(albumKey);
    const publicPath = publicPathForFile(fileName);
    const updatedAt = nowIso();
    db.prepare(
      `INSERT INTO album_image_cache
         (album_key, source_url, local_path, public_path, mime_type, byte_size, content_hash, last_accessed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(album_key) DO UPDATE SET
         source_url = excluded.source_url,
         local_path = excluded.local_path,
         public_path = excluded.public_path,
         mime_type = excluded.mime_type,
         byte_size = excluded.byte_size,
         content_hash = excluded.content_hash,
         last_accessed_at = excluded.last_accessed_at,
         updated_at = excluded.updated_at`
    ).run(albumKey, safeSourceUrl, localPath, publicPath, mimeType, bytes.length, contentHash, updatedAt, updatedAt, updatedAt);

    if (previous?.local_path && previous.local_path !== localPath) {
      deleteLocalFile(previous.local_path);
      replaceCoverReferences(previous.public_path, safeSourceUrl);
    }

    applyLocalCoverReferences({
      albumKey,
      title: clampText(title, 160),
      artist: clampText(artist, 160),
      publicPath
    });
    pruneLocalCoverCache();
    return {
      albumKey,
      sourceUrl: safeSourceUrl,
      publicPath,
      mimeType,
      byteSize: bytes.length,
      contentHash,
      reused: false
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function pruneLocalCoverCache() {
  coverCacheDir();
  let rows = db
    .prepare(
      `SELECT album_key, source_url, local_path, public_path, byte_size
       FROM album_image_cache
       WHERE local_path != '' AND public_path != ''
       ORDER BY last_accessed_at ASC, updated_at ASC, album_key ASC`
    )
    .all();
  let count = rows.length;
  let totalBytes = rows.reduce((sum, row) => sum + Number(row.byte_size || 0), 0);
  const evicted = [];

  for (const row of rows) {
    if (count <= config.maxLocalCoverImages && totalBytes <= config.maxLocalCoverBytes) break;
    deleteLocalFile(row.local_path);
    const updatedAt = nowIso();
    db.prepare(
      `UPDATE album_image_cache
       SET local_path = '',
           public_path = '',
           mime_type = '',
           byte_size = 0,
           content_hash = '',
           updated_at = ?
       WHERE album_key = ?`
    ).run(updatedAt, row.album_key);
    replaceCoverReferences(row.public_path, row.source_url || '');
    evicted.push(row.public_path);
    count -= 1;
    totalBytes -= Number(row.byte_size || 0);
  }

  return {
    evictedCount: evicted.length,
    evicted
  };
}

export function localCoverCacheSummary() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(byte_size), 0) AS byte_size,
              MIN(last_accessed_at) AS oldest_accessed_at,
              MAX(last_accessed_at) AS newest_accessed_at
       FROM album_image_cache
       WHERE local_path != '' AND public_path != ''`
    )
    .get();
  return {
    count: Number(row?.count || 0),
    byteSize: Number(row?.byte_size || 0),
    maxImages: config.maxLocalCoverImages,
    maxBytes: config.maxLocalCoverBytes,
    oldestAccessedAt: row?.oldest_accessed_at || null,
    newestAccessedAt: row?.newest_accessed_at || null,
    directory: coverCacheDir()
  };
}

export function serveLocalCover(req, res, next) {
  const fileName = path.basename(String(req.params.file || ''));
  const publicPath = publicPathForFile(fileName);
  if (!safeCoverPublicPath(publicPath)) {
    next();
    return;
  }
  const localPath = localPathFromPublicPath(publicPath);
  if (!localPath || !fs.existsSync(localPath)) {
    next();
    return;
  }
  touchLocalCover(publicPath);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(localPath);
}
