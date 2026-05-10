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
    disc_number INTEGER NOT NULL DEFAULT 1,
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
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'fixed', 'wont_fix')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'public_report',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reporter_username TEXT NOT NULL DEFAULT '',
    page_path TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    ip_hash TEXT NOT NULL DEFAULT '',
    body_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  CREATE TABLE IF NOT EXISTS explore_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    share_link TEXT NOT NULL DEFAULT '',
    source_list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
    source_list_name TEXT NOT NULL DEFAULT '',
    source_owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_owner_username TEXT NOT NULL DEFAULT '',
    visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    album_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    imported_at TEXT
  );

  CREATE TABLE IF NOT EXISTS explore_playlist_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES explore_playlists(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album_key TEXT NOT NULL,
    cover_url TEXT NOT NULL DEFAULT '',
    release_year INTEGER,
    source_list_album_id INTEGER REFERENCES list_albums(id) ON DELETE SET NULL,
    source_added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_added_by_username TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS album_cover_cache (
    album_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS album_metadata_cache (
    album_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS album_track_cache (
    album_key TEXT NOT NULL,
    track_key TEXT NOT NULL,
    title TEXT NOT NULL,
    disc_number INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (album_key, track_key)
  );

  CREATE TABLE IF NOT EXISTS album_image_cache (
    album_key TEXT PRIMARY KEY,
    source_url TEXT NOT NULL DEFAULT '',
    local_path TEXT NOT NULL DEFAULT '',
    public_path TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS album_search_cache (
    search_key TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    normalized_query TEXT NOT NULL,
    results_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    result_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cover_probe_cache (
    url_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    status_code INTEGER,
    content_type TEXT NOT NULL DEFAULT '',
    byte_size INTEGER,
    final_url TEXT NOT NULL DEFAULT '',
    failure_reason TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS album_cover_lookup_failures (
    album_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    last_attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_retry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS album_hydration_status (
    album_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    metadata_status TEXT NOT NULL DEFAULT 'missing' CHECK (metadata_status IN ('missing', 'queued', 'hydrating', 'complete', 'failed', 'stale')),
    cover_status TEXT NOT NULL DEFAULT 'missing' CHECK (cover_status IN ('missing', 'queued', 'hydrating', 'complete', 'failed', 'stale')),
    track_status TEXT NOT NULL DEFAULT 'missing' CHECK (track_status IN ('missing', 'queued', 'hydrating', 'complete', 'failed', 'stale')),
    metadata_updated_at TEXT,
    cover_updated_at TEXT,
    tracks_updated_at TEXT,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS metadata_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('album_metadata', 'cover', 'tracklist', 'explore_cover')),
    album_key TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    source_context TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 50,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS active_visitors (
    visitor_id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    path TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    ip_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN (
      'disable',
      'enable',
      'anonymize',
      'report_status',
      'database_backup',
      'bug_create',
      'bug_update',
      'bug_delete',
      'maintenance_update',
      'explore_playlist_create',
      'explore_playlist_update',
      'explore_playlist_delete',
      'explore_playlist_import'
    )),
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
  CREATE INDEX IF NOT EXISTS idx_album_tracks_album ON album_tracks(list_album_id, disc_number, position);
  CREATE INDEX IF NOT EXISTS idx_completions_album ON album_completions(list_album_id);
  CREATE INDEX IF NOT EXISTS idx_removal_votes_album ON list_album_removal_votes(list_album_id);
  CREATE INDEX IF NOT EXISTS idx_list_messages_list ON list_messages(list_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_album ON track_ratings(album_key);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_album_track ON track_ratings(album_key, track_key);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_user_album ON track_ratings(user_id, album_key);
  CREATE INDEX IF NOT EXISTS idx_track_ratings_user_rating ON track_ratings(user_id, rating, album_key);
  CREATE INDEX IF NOT EXISTS idx_user_album_activity_user ON user_album_activity(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_user_album_activity_album_updated ON user_album_activity(album_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_album_completions_user_completed ON album_completions(user_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_list_albums_album_updated ON list_albums(album_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_list_invites_invitee ON list_invites(invitee_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_album_cover_cache_updated ON album_cover_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_album_metadata_cache_updated ON album_metadata_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_album_track_cache_album ON album_track_cache(album_key, disc_number, position);
  CREATE INDEX IF NOT EXISTS idx_album_image_cache_accessed ON album_image_cache(last_accessed_at);
  CREATE INDEX IF NOT EXISTS idx_album_image_cache_updated ON album_image_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_album_image_cache_public_path ON album_image_cache(public_path);
  CREATE INDEX IF NOT EXISTS idx_album_search_cache_expires ON album_search_cache(expires_at);
  CREATE INDEX IF NOT EXISTS idx_album_search_cache_updated ON album_search_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_album_search_cache_normalized ON album_search_cache(normalized_query);
  CREATE INDEX IF NOT EXISTS idx_cover_probe_cache_expires ON cover_probe_cache(expires_at);
  CREATE INDEX IF NOT EXISTS idx_cover_probe_cache_checked ON cover_probe_cache(checked_at);
  CREATE INDEX IF NOT EXISTS idx_album_cover_lookup_failures_retry ON album_cover_lookup_failures(next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_album_cover_lookup_failures_updated ON album_cover_lookup_failures(updated_at);
  CREATE INDEX IF NOT EXISTS idx_album_hydration_status_metadata ON album_hydration_status(metadata_status);
  CREATE INDEX IF NOT EXISTS idx_album_hydration_status_cover ON album_hydration_status(cover_status);
  CREATE INDEX IF NOT EXISTS idx_album_hydration_status_track ON album_hydration_status(track_status);
  CREATE INDEX IF NOT EXISTS idx_metadata_jobs_claim ON metadata_jobs(status, priority, available_at, id);
  CREATE INDEX IF NOT EXISTS idx_metadata_jobs_album ON metadata_jobs(album_key);
  CREATE INDEX IF NOT EXISTS idx_metadata_jobs_updated ON metadata_jobs(updated_at);
  CREATE INDEX IF NOT EXISTS idx_explore_playlists_visible_order ON explore_playlists(visible, sort_order, name);
  CREATE INDEX IF NOT EXISTS idx_explore_playlist_albums_playlist_order ON explore_playlist_albums(playlist_id, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_explore_playlist_albums_key ON explore_playlist_albums(album_key);
  CREATE INDEX IF NOT EXISTS idx_active_visitors_last_seen ON active_visitors(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_active_visitors_user ON active_visitors(user_id, last_seen_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_list_invites_one_pending
    ON list_invites(list_id, invitee_user_id)
    WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_admin_action_log_user ON admin_action_log(user_id, created_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error?.message || ''))) throw error;
    }
  }
}

ensureColumn('users', 'avatar_data_url', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'music_platform', "TEXT NOT NULL DEFAULT 'na'");
ensureColumn('users', 'accent_color', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'disabled_at', 'TEXT');
ensureColumn('users', 'disabled_reason', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'anonymized_at', 'TEXT');
ensureColumn('album_tracks', 'disc_number', 'INTEGER NOT NULL DEFAULT 1');

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

function tableSql(table) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || '';
}

function tableColumnNames(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function firstText(row, names, fallback = '') {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

function cleanMigratedBugStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'reviewing') return 'in_progress';
  if (status === 'closed') return 'fixed';
  if (status === 'spam') return 'wont_fix';
  if (['open', 'in_progress', 'fixed', 'wont_fix'].includes(status)) return status;
  return 'open';
}

function cleanMigratedBugPriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'critical'].includes(priority) ? priority : 'medium';
}

function migratedBugTitle(row) {
  const explicit = firstText(row, ['title']);
  if (explicit) return explicit.slice(0, 160);
  const description = firstText(row, ['description', 'details', 'body']);
  const firstLine = description.split(/\r?\n/).find((line) => line.trim());
  if (firstLine) return firstLine.trim().slice(0, 120);
  return `Bug report ${row.id || ''}`.trim();
}

function createBugReportsTable(tableName) {
  db.exec(`
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'fixed', 'wont_fix')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
      notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'public_report',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reporter_username TEXT NOT NULL DEFAULT '',
      page_path TEXT NOT NULL DEFAULT '',
      browser TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL DEFAULT '',
      body_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function migrateBugReportsTable() {
  const columns = tableColumnNames('bug_reports');
  const sql = tableSql('bug_reports');
  const desired =
    columns.has('title') &&
    columns.has('description') &&
    columns.has('priority') &&
    columns.has('notes') &&
    columns.has('page_path') &&
    columns.has('updated_at') &&
    sql.includes('in_progress') &&
    sql.includes('wont_fix');
  if (desired) return;

  const rows = db.prepare('SELECT * FROM bug_reports ORDER BY id').all();
  const now = new Date().toISOString();

  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS bug_reports_new;
  `);
  createBugReportsTable('bug_reports_new');

  const insert = db.prepare(
    `INSERT INTO bug_reports_new
     (id, title, description, status, priority, notes, source, user_id, reporter_username, page_path, browser, user_agent, ip_hash, body_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const row of rows) {
    const createdAt = firstText(row, ['created_at'], now);
    insert.run(
      row.id,
      migratedBugTitle(row),
      firstText(row, ['description', 'details', 'body'], migratedBugTitle(row)),
      cleanMigratedBugStatus(row.status),
      cleanMigratedBugPriority(row.priority),
      firstText(row, ['notes']),
      firstText(row, ['source'], 'public_report'),
      row.user_id ?? null,
      firstText(row, ['reporter_username', 'username']),
      firstText(row, ['page_path', 'path']),
      firstText(row, ['browser', 'user_agent']),
      firstText(row, ['user_agent', 'browser']),
      firstText(row, ['ip_hash']),
      firstText(row, ['body_hash']),
      createdAt,
      firstText(row, ['updated_at'], createdAt)
    );
  }

  db.exec(`
    DROP TABLE bug_reports;
    ALTER TABLE bug_reports_new RENAME TO bug_reports;
    PRAGMA foreign_keys = ON;
  `);
}

function createAdminActionLogTable(tableName) {
  db.exec(`
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK (action IN (
        'disable',
        'enable',
        'anonymize',
        'report_status',
        'database_backup',
        'bug_create',
        'bug_update',
        'bug_delete',
        'maintenance_update',
        'explore_playlist_create',
        'explore_playlist_update',
        'explore_playlist_delete',
        'explore_playlist_import'
      )),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      previous_username TEXT NOT NULL DEFAULT '',
      new_username TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function migrateAdminActionLogTable() {
  if (tableSql('admin_action_log').includes('maintenance_update')) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS admin_action_log_new;
  `);
  createAdminActionLogTable('admin_action_log_new');
  db.exec(`
    INSERT INTO admin_action_log_new (id, action, user_id, previous_username, new_username, details, created_at)
      SELECT id, action, user_id, previous_username, new_username, details, created_at
      FROM admin_action_log;
    DROP TABLE admin_action_log;
    ALTER TABLE admin_action_log_new RENAME TO admin_action_log;
    PRAGMA foreign_keys = ON;
  `);
}

migrateBugReportsTable();
migrateAdminActionLogTable();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_priority ON bug_reports(priority, created_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_updated ON bug_reports(updated_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_duplicate ON bug_reports(body_hash, user_id, ip_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_admin_action_log_user ON admin_action_log(user_id, created_at);
`);

db.prepare(
  `INSERT OR IGNORE INTO app_settings (key, value, description, updated_at)
   VALUES (?, ?, ?, ?)`
).run('maintenance_mode', '0', 'When set to 1, the public website returns a maintenance page and public API writes are unavailable.', new Date().toISOString());

function backfillAlbumHydrationStatus() {
  db.exec(`
    INSERT INTO album_hydration_status
      (album_key, title, artist, metadata_status, cover_status, track_status, metadata_updated_at, cover_updated_at, updated_at)
    SELECT album_key,
           title,
           artist,
           'complete',
           CASE WHEN cover_url != '' THEN 'complete' ELSE 'missing' END,
           'missing',
           updated_at,
           CASE WHEN cover_url != '' THEN updated_at ELSE NULL END,
           updated_at
    FROM album_metadata_cache
    WHERE true
    ON CONFLICT(album_key) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE album_hydration_status.title END,
      artist = CASE WHEN excluded.artist != '' THEN excluded.artist ELSE album_hydration_status.artist END,
      metadata_status = CASE
        WHEN album_hydration_status.metadata_status IN ('missing', 'stale') THEN 'complete'
        ELSE album_hydration_status.metadata_status
      END,
      cover_status = CASE
        WHEN excluded.cover_status = 'complete' AND album_hydration_status.cover_status IN ('missing', 'stale', 'failed') THEN 'complete'
        ELSE album_hydration_status.cover_status
      END,
      metadata_updated_at = COALESCE(album_hydration_status.metadata_updated_at, excluded.metadata_updated_at),
      cover_updated_at = COALESCE(album_hydration_status.cover_updated_at, excluded.cover_updated_at),
      updated_at = excluded.updated_at;

    INSERT INTO album_hydration_status
      (album_key, title, artist, metadata_status, cover_status, track_status, updated_at)
    SELECT la.album_key,
           MAX(la.title),
           MAX(la.artist),
           'missing',
           CASE WHEN MAX(CASE WHEN la.cover_url != '' THEN 1 ELSE 0 END) = 1 THEN 'complete' ELSE 'missing' END,
           'missing',
           MAX(la.updated_at)
    FROM list_albums la
    GROUP BY la.album_key
    HAVING true
    ON CONFLICT(album_key) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE album_hydration_status.title END,
      artist = CASE WHEN excluded.artist != '' THEN excluded.artist ELSE album_hydration_status.artist END,
      cover_status = CASE
        WHEN excluded.cover_status = 'complete' AND album_hydration_status.cover_status IN ('missing', 'stale', 'failed') THEN 'complete'
        ELSE album_hydration_status.cover_status
      END,
      updated_at = CASE
        WHEN excluded.updated_at > album_hydration_status.updated_at THEN excluded.updated_at
        ELSE album_hydration_status.updated_at
      END;

    INSERT INTO album_hydration_status
      (album_key, title, artist, metadata_status, cover_status, track_status, tracks_updated_at, updated_at)
    SELECT atc.album_key,
           COALESCE(am.title, la.title, atc.album_key),
           COALESCE(am.artist, la.artist, ''),
           CASE WHEN am.album_key IS NOT NULL THEN 'complete' ELSE 'missing' END,
           CASE WHEN COALESCE(am.cover_url, la.cover_url, '') != '' THEN 'complete' ELSE 'missing' END,
           'complete',
           MAX(atc.updated_at),
           MAX(atc.updated_at)
    FROM album_track_cache atc
    LEFT JOIN album_metadata_cache am ON am.album_key = atc.album_key
    LEFT JOIN (
      SELECT album_key, MAX(title) AS title, MAX(artist) AS artist, MAX(cover_url) AS cover_url
      FROM list_albums
      GROUP BY album_key
    ) la ON la.album_key = atc.album_key
    GROUP BY atc.album_key
    HAVING true
    ON CONFLICT(album_key) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE album_hydration_status.title END,
      artist = CASE WHEN excluded.artist != '' THEN excluded.artist ELSE album_hydration_status.artist END,
      metadata_status = CASE
        WHEN excluded.metadata_status = 'complete' AND album_hydration_status.metadata_status IN ('missing', 'stale', 'failed') THEN 'complete'
        ELSE album_hydration_status.metadata_status
      END,
      cover_status = CASE
        WHEN excluded.cover_status = 'complete' AND album_hydration_status.cover_status IN ('missing', 'stale', 'failed') THEN 'complete'
        ELSE album_hydration_status.cover_status
      END,
      track_status = 'complete',
      tracks_updated_at = excluded.tracks_updated_at,
      updated_at = excluded.updated_at;
  `);
}

backfillAlbumHydrationStatus();

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
              `INSERT INTO album_tracks (list_album_id, track_key, title, disc_number, position)
               SELECT ?, track_key, title, disc_number, position
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
      `INSERT INTO album_tracks (list_album_id, track_key, title, disc_number, position)
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const album of affectedAlbums) {
      deleteTracks.run(album.id);
      canonicalTracks.forEach((title, index) => {
        insertTrack.run(album.id, trackKey(title, index + 1), title, 1, index + 1);
      });
    }
  })();
}

repairKnownAlbumTracklists();
ensureUniqueListAlbums();
