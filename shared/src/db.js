import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const databaseDir = path.dirname(config.databasePath);
fs.mkdirSync(databaseDir, { recursive: true });

export const db = new DatabaseSync(config.databasePath);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA journal_size_limit = 67108864;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    avatar_data_url TEXT NOT NULL DEFAULT '',
    music_platform TEXT NOT NULL DEFAULT 'na',
    accent_color TEXT NOT NULL DEFAULT '',
    history_token TEXT NOT NULL UNIQUE,
    history_visibility TEXT NOT NULL DEFAULT 'private' CHECK (history_visibility IN ('private', 'unlisted')),
    theme_preference TEXT NOT NULL DEFAULT 'system' CHECK (theme_preference IN ('system', 'light', 'dark', 'retro')),
    disabled_at TEXT,
    disabled_reason TEXT NOT NULL DEFAULT '',
    anonymized_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'collab')),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    share_token TEXT NOT NULL UNIQUE,
    invite_token TEXT NOT NULL UNIQUE,
    show_ratings INTEGER NOT NULL DEFAULT 1 CHECK (show_ratings IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS list_members (
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (list_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS list_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    inviter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'viewer')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    responded_at TEXT
  );

  CREATE TABLE IF NOT EXISTS list_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    album_key TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS album_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_album_id INTEGER NOT NULL REFERENCES list_albums(id) ON DELETE CASCADE,
    track_key TEXT NOT NULL,
    title TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS album_completions (
    list_album_id INTEGER NOT NULL REFERENCES list_albums(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (list_album_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS list_album_removal_votes (
    list_album_id INTEGER NOT NULL REFERENCES list_albums(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (list_album_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS list_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bug_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    ip_hash TEXT NOT NULL DEFAULT '',
    body_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'closed', 'spam')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS track_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_key TEXT NOT NULL,
    track_key TEXT NOT NULL,
    track_title TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 10),
    include_in_average INTEGER NOT NULL DEFAULT 1 CHECK (include_in_average IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, album_key, track_key)
  );

  CREATE TABLE IF NOT EXISTS album_average_opt_in (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_key TEXT NOT NULL,
    include_in_average INTEGER NOT NULL DEFAULT 1 CHECK (include_in_average IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, album_key)
  );

  CREATE TABLE IF NOT EXISTS user_album_activity (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_key TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    completed_at TEXT,
    rated_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, album_key)
  );

  CREATE TABLE IF NOT EXISTS explore_album_covers (
    slug TEXT NOT NULL,
    album_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (slug, album_index)
  );

  CREATE TABLE IF NOT EXISTS admin_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN ('disable', 'enable', 'anonymize', 'report_status', 'database_backup')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    previous_username TEXT NOT NULL DEFAULT '',
    new_username TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_lists_visibility_updated ON lists(visibility, updated_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_list_members_user ON list_members(user_id, list_id);
  CREATE INDEX IF NOT EXISTS idx_list_albums_list ON list_albums(list_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_list_albums_album_key ON list_albums(album_key);
  CREATE INDEX IF NOT EXISTS idx_album_tracks_album ON album_tracks(list_album_id, position);
  CREATE INDEX IF NOT EXISTS idx_completions_album ON album_completions(list_album_id);
  CREATE INDEX IF NOT EXISTS idx_removal_votes_album ON list_album_removal_votes(list_album_id);
  CREATE INDEX IF NOT EXISTS idx_list_messages_list ON list_messages(list_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_duplicate ON bug_reports(body_hash, user_id, ip_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_album ON track_ratings(album_key);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_album_track ON track_ratings(album_key, track_key);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_user_album ON track_ratings(user_id, album_key);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_user_rating ON track_ratings(user_id, rating, album_key);
  CREATE INDEX IF NOT EXISTS idx_user_album_activity_user ON user_album_activity(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_user_album_activity_album_updated ON user_album_activity(album_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_album_completions_user_completed ON album_completions(user_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_list_albums_album_updated ON list_albums(album_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_list_invites_invitee ON list_invites(invitee_user_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_list_invites_one_pending
    ON list_invites(list_id, invitee_user_id)
    WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_admin_action_log_user ON admin_action_log(user_id, created_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('users', 'avatar_data_url', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'music_platform', "TEXT NOT NULL DEFAULT 'na'");
ensureColumn('users', 'accent_color', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'disabled_at', 'TEXT');
ensureColumn('users', 'disabled_reason', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'anonymized_at', 'TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_disabled ON users(disabled_at);
  CREATE INDEX IF NOT EXISTS idx_users_anonymized ON users(anonymized_at);
`);

const inviteTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'list_invites'").get();
if (inviteTable?.sql?.includes('UNIQUE (list_id, invitee_user_id, status)')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE list_invites RENAME TO list_invites_old;
    CREATE TABLE list_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      inviter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invitee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'viewer')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT
    );
    INSERT INTO list_invites (id, list_id, inviter_user_id, invitee_user_id, role, status, created_at, responded_at)
      SELECT id, list_id, inviter_user_id, invitee_user_id, role, status, created_at, responded_at
      FROM list_invites_old;
    DROP TABLE list_invites_old;
    PRAGMA foreign_keys = ON;
    CREATE INDEX IF NOT EXISTS idx_list_invites_invitee ON list_invites(invitee_user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_list_invites_one_pending
      ON list_invites(list_id, invitee_user_id)
      WHERE status = 'pending';
  `);
}

const adminActionLogTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_action_log'").get();
if (adminActionLogTable?.sql?.includes("action IN ('disable', 'enable', 'anonymize')")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE admin_action_log RENAME TO admin_action_log_old;
    CREATE TABLE admin_action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK (action IN ('disable', 'enable', 'anonymize', 'report_status', 'database_backup')),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      previous_username TEXT NOT NULL DEFAULT '',
      new_username TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO admin_action_log (id, action, user_id, previous_username, new_username, details, created_at)
      SELECT id, action, user_id, previous_username, new_username, details, created_at
      FROM admin_action_log_old;
    DROP TABLE admin_action_log_old;
    PRAGMA foreign_keys = ON;
    CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_admin_action_log_user ON admin_action_log(user_id, created_at);
  `);
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function albumKey(title, artist) {
  const normalizedTitle = normalizeText(title);
  const normalizedArtist = normalizeText(artist);
  return `${normalizedArtist || 'unknown'}::${normalizedTitle}`;
}

export function trackKey(title, position = 0) {
  const normalizedTitle = normalizeText(title);
  return normalizedTitle || `track-${position}`;
}

export function closeDatabase() {
  db.close();
}

let transactionDepth = 0;

export function transaction(fn) {
  return (...args) => {
    const isOuter = transactionDepth === 0;
    const savepoint = `sp_${transactionDepth}`;

    if (isOuter) db.exec('BEGIN');
    else db.exec(`SAVEPOINT ${savepoint}`);

    transactionDepth += 1;

    try {
      const result = fn(...args);
      transactionDepth -= 1;

      if (isOuter) db.exec('COMMIT');
      else db.exec(`RELEASE ${savepoint}`);

      return result;
    } catch (error) {
      transactionDepth -= 1;

      if (isOuter) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);

      throw error;
    }
  };
}

function ensureUniqueListAlbums() {
  const duplicateGroups = db
    .prepare(
      `SELECT list_id, album_key, COUNT(*) AS count
       FROM list_albums
       GROUP BY list_id, album_key
       HAVING count > 1`
    )
    .all();

  if (duplicateGroups.length) {
    transaction(() => {
      for (const group of duplicateGroups) {
        const albums = db
          .prepare(
            `SELECT id
             FROM list_albums
             WHERE list_id = ? AND album_key = ?
             ORDER BY sort_order, created_at, id`
          )
          .all(group.list_id, group.album_key);
        const keeper = albums[0];
        if (!keeper) continue;

        for (const duplicate of albums.slice(1)) {
          const keeperTrackCount = db.prepare('SELECT COUNT(*) AS count FROM album_tracks WHERE list_album_id = ?').get(keeper.id).count;
          const duplicateTrackCount = db.prepare('SELECT COUNT(*) AS count FROM album_tracks WHERE list_album_id = ?').get(duplicate.id).count;
          if (!keeperTrackCount && duplicateTrackCount) {
            db.prepare(
              `INSERT INTO album_tracks (list_album_id, track_key, title, position)
               SELECT ?, track_key, title, position
               FROM album_tracks
               WHERE list_album_id = ?`
            ).run(keeper.id, duplicate.id);
          }

          db.prepare(
            `INSERT OR IGNORE INTO album_completions (list_album_id, user_id, completed_at)
             SELECT ?, user_id, completed_at
             FROM album_completions
             WHERE list_album_id = ?`
          ).run(keeper.id, duplicate.id);

          db.prepare('DELETE FROM list_albums WHERE id = ?').run(duplicate.id);
        }
      }
    })();
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_list_albums_unique_key ON list_albums(list_id, album_key)');
}

function repairKnownAlbumTracklists() {
  const bowieAlbumKey = albumKey('The Man Who Sold the World', 'David Bowie');
  const canonicalTracks = [
    'The Width of a Circle',
    'All the Madmen',
    'Black Country Rock',
    'After All',
    'Running Gun Blues',
    'Saviour Machine',
    'She Shook Me Cold',
    'The Man Who Sold the World',
    'The Supermen'
  ];
  const knownBonusTrackKeys = new Set(['lightning frightening', 'holy holy', 'moonage daydream', 'hang onto yourself', 'hang on to yourself']);
  const affectedAlbums = db
    .prepare(
      `SELECT la.id
       FROM list_albums la
       JOIN album_tracks at ON at.list_album_id = la.id
       WHERE la.album_key = ?
       GROUP BY la.id
       HAVING COUNT(at.id) != ? OR SUM(CASE WHEN at.track_key IN (${[...knownBonusTrackKeys].map(() => '?').join(',')}) THEN 1 ELSE 0 END) > 0`
    )
    .all(bowieAlbumKey, canonicalTracks.length, ...knownBonusTrackKeys);

  if (!affectedAlbums.length) return;

  transaction(() => {
    db.prepare(
      `UPDATE OR IGNORE track_ratings
       SET track_key = ?, track_title = ?
       WHERE album_key = ? AND track_key = ?`
    ).run(trackKey(canonicalTracks[0], 1), canonicalTracks[0], bowieAlbumKey, trackKey('Width of a Circle', 1));

    const deleteTracks = db.prepare('DELETE FROM album_tracks WHERE list_album_id = ?');
    const insertTrack = db.prepare(
      `INSERT INTO album_tracks (list_album_id, track_key, title, position)
       VALUES (?, ?, ?, ?)`
    );

    for (const album of affectedAlbums) {
      deleteTracks.run(album.id);
      canonicalTracks.forEach((title, index) => {
        insertTrack.run(album.id, trackKey(title, index + 1), title, index + 1);
      });
    }
  })();
}

repairKnownAlbumTracklists();
ensureUniqueListAlbums();
