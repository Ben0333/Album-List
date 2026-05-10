import { db, nowIso } from '@albums/shared/db';

export const hydrationStatuses = new Set(['missing', 'queued', 'hydrating', 'complete', 'failed', 'stale']);

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeStatus(value, fallback = 'missing') {
  const status = clampText(value, 20);
  return hydrationStatuses.has(status) ? status : fallback;
}

function normalizeAlbum(input) {
  const albumKey = clampText(input?.albumKey ?? input?.album_key, 320);
  const title = clampText(input?.title, 160);
  const artist = clampText(input?.artist, 160);
  if (!albumKey) return null;
  return { albumKey, title, artist };
}

export function upsertAlbumHydrationStatus(albumInput, updates = {}) {
  const album = normalizeAlbum(albumInput);
  if (!album) return null;

  const updatedAt = updates.updatedAt || nowIso();
  const insertMetadataStatus =
    updates.metadataStatus === undefined ? 'missing' : normalizeStatus(updates.metadataStatus);
  const insertCoverStatus = updates.coverStatus === undefined ? 'missing' : normalizeStatus(updates.coverStatus);
  const insertTrackStatus = updates.trackStatus === undefined ? 'missing' : normalizeStatus(updates.trackStatus);

  db.prepare(
    `INSERT OR IGNORE INTO album_hydration_status
       (album_key, title, artist, metadata_status, cover_status, track_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(album.albumKey, album.title, album.artist, insertMetadataStatus, insertCoverStatus, insertTrackStatus, updatedAt);

  const assignments = [];
  const values = [];

  if (album.title) {
    assignments.push('title = ?');
    values.push(album.title);
  }
  if (album.artist) {
    assignments.push('artist = ?');
    values.push(album.artist);
  }
  if (updates.metadataStatus !== undefined) {
    assignments.push('metadata_status = ?');
    values.push(normalizeStatus(updates.metadataStatus));
  }
  if (updates.coverStatus !== undefined) {
    assignments.push('cover_status = ?');
    values.push(normalizeStatus(updates.coverStatus));
  }
  if (updates.trackStatus !== undefined) {
    assignments.push('track_status = ?');
    values.push(normalizeStatus(updates.trackStatus));
  }
  if (updates.metadataUpdatedAt !== undefined) {
    assignments.push('metadata_updated_at = ?');
    values.push(updates.metadataUpdatedAt || null);
  }
  if (updates.coverUpdatedAt !== undefined) {
    assignments.push('cover_updated_at = ?');
    values.push(updates.coverUpdatedAt || null);
  }
  if (updates.tracksUpdatedAt !== undefined) {
    assignments.push('tracks_updated_at = ?');
    values.push(updates.tracksUpdatedAt || null);
  }
  if (updates.lastError !== undefined) {
    assignments.push('last_error = ?');
    values.push(clampText(updates.lastError, 1000));
  }

  assignments.push('updated_at = ?');
  values.push(updatedAt);
  values.push(album.albumKey);

  db.prepare(`UPDATE album_hydration_status SET ${assignments.join(', ')} WHERE album_key = ?`).run(...values);
  return album.albumKey;
}

export function albumHydrationStatus(albumKeyValue) {
  const albumKey = clampText(albumKeyValue, 320);
  if (!albumKey) return null;
  return db.prepare('SELECT * FROM album_hydration_status WHERE album_key = ?').get(albumKey) || null;
}

export function markHydrationJobStatus(job, status, lastError = '') {
  const normalized = normalizeStatus(status);
  const updates = { lastError };
  if (job?.kind === 'album_metadata') {
    updates.metadataStatus = normalized;
    if (normalized === 'complete') updates.metadataUpdatedAt = nowIso();
  } else if (job?.kind === 'tracklist') {
    updates.trackStatus = normalized;
    if (normalized === 'complete') updates.tracksUpdatedAt = nowIso();
  } else if (job?.kind === 'cover' || job?.kind === 'explore_cover') {
    updates.coverStatus = normalized;
    if (normalized === 'complete') updates.coverUpdatedAt = nowIso();
  } else {
    return null;
  }

  return upsertAlbumHydrationStatus(
    {
      albumKey: job.albumKey ?? job.album_key,
      title: job.title,
      artist: job.artist
    },
    updates
  );
}

export function hydrationStatusCounts() {
  const emptyCounts = Object.fromEntries([...hydrationStatuses].map((status) => [status, 0]));
  const result = {
    metadata: { ...emptyCounts },
    cover: { ...emptyCounts },
    track: { ...emptyCounts }
  };

  for (const row of db.prepare('SELECT metadata_status AS status, COUNT(*) AS count FROM album_hydration_status GROUP BY metadata_status').all()) {
    result.metadata[row.status] = Number(row.count || 0);
  }
  for (const row of db.prepare('SELECT cover_status AS status, COUNT(*) AS count FROM album_hydration_status GROUP BY cover_status').all()) {
    result.cover[row.status] = Number(row.count || 0);
  }
  for (const row of db.prepare('SELECT track_status AS status, COUNT(*) AS count FROM album_hydration_status GROUP BY track_status').all()) {
    result.track[row.status] = Number(row.count || 0);
  }

  return result;
}
