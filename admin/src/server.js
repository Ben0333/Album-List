import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { closeDatabase, db, normalizeText, nowIso, transaction } from '@albums/shared/db';
import { config } from '@albums/shared/config';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const repoRoot = path.resolve(__dirname, '..', '..');
const mainServerScript = path.join(repoRoot, 'server', 'src', 'server.js');
const mainPidFile = path.join(repoRoot, '.server.pid');
const mainHealthUrl = `http://localhost:${config.port}/api/health`;
const tunnelControlScript = path.join(repoRoot, 'admin', 'scripts', 'cloudflare-tunnel-control.ps1');
const app = express();

app.disable('x-powered-by');

app.use(localOnly);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: false,
    referrerPolicy: { policy: 'same-origin' }
  })
);
app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  })
);

function localOnly(req, res, next) {
  const remoteAddress = req.socket.remoteAddress || '';
  const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  if (!localAddresses.has(remoteAddress)) {
    res.status(403).json({ error: { message: 'Admin dashboard is only available from this computer.', status: 403 } });
    return;
  }
  next();
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

function count(sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.count || 0);
}

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPid(filePath) {
  try {
    const value = Number(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(900) });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return data?.ok === true;
  } catch {
    return false;
  }
}

async function mainStatus() {
  const pid = readPid(mainPidFile);
  const pidRunning = processExists(pid);
  const healthy = await healthOk(mainHealthUrl);
  return {
    port: config.port,
    pid,
    pidRunning,
    healthy,
    running: pidRunning || healthy,
    healthUrl: mainHealthUrl
  };
}

async function findMainProcessIds() {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*apps/main/src/server.js*' } | Select-Object -ExpandProperty ProcessId"
      ],
      { windowsHide: true }
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

async function stopMainWebsite() {
  const pids = new Set();
  const pid = readPid(mainPidFile);
  if (pid) pids.add(pid);
  for (const processId of await findMainProcessIds()) pids.add(processId);

  for (const processId of pids) {
    if (!processExists(processId)) continue;
    try {
      process.kill(processId, 'SIGTERM');
    } catch {
      // Fallback below handles stubborn Windows processes.
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stillRunning = [...pids].some(processExists);
    const stillHealthy = await healthOk(mainHealthUrl);
    if (!stillRunning && !stillHealthy) break;
    await sleep(250);
  }

  const stubborn = [...pids].filter(processExists);
  if (stubborn.length && process.platform === 'win32') {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${stubborn.join(',')} -Force`], { windowsHide: true }).catch(() => {});
  }

  fs.rmSync(mainPidFile, { force: true });
  return mainStatus();
}

async function startMainWebsite() {
  const status = await mainStatus();
  if (status.running) return status;

  const child = spawnMainWebsite();
  fs.writeFileSync(mainPidFile, String(child.pid));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await healthOk(mainHealthUrl)) break;
    if (!processExists(child.pid)) break;
    await sleep(300);
  }

  return mainStatus();
}

function spawnMainWebsite() {
  const child = spawn(process.execPath, [mainServerScript], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return child;
}

async function tunnelControl(action) {
  if (process.platform !== 'win32') {
    throw httpError(400, 'Cloudflare tunnel controls are only configured for Windows.');
  }
  if (!fs.existsSync(tunnelControlScript)) {
    throw httpError(500, 'Cloudflare tunnel control script is missing.');
  }

  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tunnelControlScript, '-Action', action],
    { windowsHide: true, timeout: 120_000 }
  );
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw httpError(500, stderr.trim() || 'Cloudflare tunnel command did not return status.');
  }
  try {
    return JSON.parse(line);
  } catch {
    throw httpError(500, `Cloudflare tunnel command returned invalid status: ${line}`);
  }
}

function uniqueHistoryToken() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const token = randomToken(18);
    const exists = db.prepare('SELECT 1 FROM users WHERE history_token = ?').get(token);
    if (!exists) return token;
  }
  throw httpError(500, 'Could not create a unique history token.');
}

function uniqueAnonymizedIdentity() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const suffix = crypto.randomBytes(3).toString('hex');
    const username = `anonymized_user_${suffix}`;
    const usernameNormalized = normalizeText(username);
    const email = `anonymized_${suffix}@example.invalid`;
    const exists = db
      .prepare('SELECT 1 FROM users WHERE username_normalized = ? OR email_normalized = ?')
      .get(usernameNormalized, email);
    if (!exists) return { username, usernameNormalized, email };
  }
  throw httpError(500, 'Could not create a unique anonymized account name.');
}

function getAccountOrThrow(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw httpError(404, 'Account not found.');
  return user;
}

function accountSummary(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at,
    disabledAt: row.disabled_at || null,
    disabledReason: row.disabled_reason || '',
    anonymizedAt: row.anonymized_at || null,
    ownedLists: Number(row.owned_lists || 0),
    memberships: Number(row.memberships || 0),
    albumsAdded: Number(row.albums_added || 0),
    completions: Number(row.completions || 0),
    ratings: Number(row.ratings || 0),
    activityRecords: Number(row.activity_records || 0)
  };
}

function accountQuery() {
  return `
    SELECT u.*,
      (SELECT COUNT(*) FROM lists WHERE owner_user_id = u.id) AS owned_lists,
      (SELECT COUNT(*) FROM list_members WHERE user_id = u.id) AS memberships,
      (SELECT COUNT(*) FROM list_albums WHERE created_by = u.id) AS albums_added,
      (SELECT COUNT(*) FROM album_completions WHERE user_id = u.id) AS completions,
      (SELECT COUNT(*) FROM track_ratings WHERE user_id = u.id) AS ratings,
      (SELECT COUNT(*) FROM user_album_activity WHERE user_id = u.id) AS activity_records
    FROM users u
  `;
}

function accountById(userId) {
  return accountSummary(db.prepare(`${accountQuery()} WHERE u.id = ?`).get(userId));
}

function listAccounts(query, limit = 50) {
  const cleanQuery = clampText(query, 120);
  const cleanLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  if (!cleanQuery) {
    return db
      .prepare(`${accountQuery()} ORDER BY datetime(u.created_at) DESC, u.id DESC LIMIT ?`)
      .all(cleanLimit)
      .map(accountSummary);
  }

  const normalized = normalizeText(cleanQuery);
  const email = cleanQuery.toLowerCase();
  const numericId = Number(cleanQuery);
  const clauses = ['u.username_normalized LIKE ?', 'u.email_normalized LIKE ?'];
  const params = [`%${normalized}%`, `%${email}%`];
  if (Number.isInteger(numericId) && numericId > 0) {
    clauses.push('u.id = ?');
    params.push(numericId);
  }

  return db
    .prepare(`${accountQuery()} WHERE ${clauses.join(' OR ')} ORDER BY datetime(u.created_at) DESC, u.id DESC LIMIT ?`)
    .all(...params, cleanLimit)
    .map(accountSummary);
}

function logAction(action, userId, previousUsername, newUsername, details) {
  db.prepare(
    `INSERT INTO admin_action_log (action, user_id, previous_username, new_username, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(action, userId, previousUsername || '', newUsername || '', details || '', nowIso());
}

function recentActions(limit = 12) {
  return db
    .prepare(
      `SELECT id, action, user_id, previous_username, new_username, details, created_at
       FROM admin_action_log
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(limit)
    .map((row) => ({
      id: row.id,
      action: row.action,
      userId: row.user_id,
      previousUsername: row.previous_username,
      newUsername: row.new_username,
      details: row.details,
      createdAt: row.created_at
    }));
}

function disableAccount(userId, reason) {
  const user = getAccountOrThrow(userId);
  const disabledAt = user.disabled_at || nowIso();
  const cleanReason = clampText(reason, 300) || 'Disabled by local admin';

  transaction(() => {
    db.prepare('UPDATE users SET disabled_at = ?, disabled_reason = ? WHERE id = ?').run(disabledAt, cleanReason, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    logAction('disable', user.id, user.username, user.username, cleanReason);
  })();

  return accountById(user.id);
}

function enableAccount(userId) {
  const user = getAccountOrThrow(userId);
  if (user.anonymized_at) {
    throw httpError(400, 'Anonymized accounts cannot be re-enabled.');
  }

  transaction(() => {
    db.prepare("UPDATE users SET disabled_at = NULL, disabled_reason = '' WHERE id = ?").run(user.id);
    logAction('enable', user.id, user.username, user.username, 'Account enabled by local admin');
  })();

  return accountById(user.id);
}

function anonymizeAccount(userId) {
  const user = getAccountOrThrow(userId);
  if (user.anonymized_at) {
    throw httpError(409, 'Account is already anonymized.');
  }

  const identity = uniqueAnonymizedIdentity();
  const actionTime = nowIso();
  const passwordHash = bcrypt.hashSync(randomToken(24), 12);
  const historyToken = uniqueHistoryToken();

  transaction(() => {
    db.prepare(
      `UPDATE users
       SET username = ?,
           username_normalized = ?,
           email = ?,
           email_normalized = ?,
           password_hash = ?,
           avatar_color = ?,
           avatar_data_url = '',
           music_platform = 'na',
           accent_color = '',
           history_token = ?,
           history_visibility = 'private',
           theme_preference = 'system',
           disabled_at = ?,
           disabled_reason = ?,
           anonymized_at = ?
       WHERE id = ?`
    ).run(
      identity.username,
      identity.usernameNormalized,
      identity.email,
      identity.email,
      passwordHash,
      '#64748b',
      historyToken,
      actionTime,
      'Anonymized by local admin',
      actionTime,
      user.id
    );
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    logAction('anonymize', user.id, user.username, identity.username, 'Account anonymized; related data preserved.');
  })();

  return accountById(user.id);
}

app.get(
  '/api/health',
  route((req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: nowIso(), database: 'ok' });
  })
);

app.get(
  '/api/site/status',
  route(async (req, res) => {
    res.json({ site: await mainStatus() });
  })
);

app.post(
  '/api/site/start',
  route(async (req, res) => {
    res.json({ site: await startMainWebsite(), message: 'Website start requested.' });
  })
);

app.post(
  '/api/site/stop',
  route(async (req, res) => {
    res.json({ site: await stopMainWebsite(), message: 'Website stopped.' });
  })
);

app.post(
  '/api/site/restart',
  route(async (req, res) => {
    await stopMainWebsite();
    const site = await startMainWebsite();
    res.json({ site, message: 'Website restarted.' });
  })
);

app.get(
  '/api/tunnel/status',
  route(async (req, res) => {
    res.json({ tunnel: await tunnelControl('Status') });
  })
);

app.post(
  '/api/tunnel/start',
  route(async (req, res) => {
    res.json({ tunnel: await tunnelControl('Start'), message: 'Cloudflare tunnel start requested.' });
  })
);

app.post(
  '/api/tunnel/stop',
  route(async (req, res) => {
    res.json({ tunnel: await tunnelControl('Stop'), message: 'Cloudflare tunnel stopped.' });
  })
);

app.post(
  '/api/lockdown',
  route(async (req, res) => {
    const tunnel = await tunnelControl('Lockdown');
    res.json({ site: await mainStatus(), tunnel, message: 'Emergency lockdown completed.' });
  })
);

app.get(
  '/api/stats',
  route((req, res) => {
    res.json({
      totals: {
        users: count('SELECT COUNT(*) AS count FROM users'),
        disabledUsers: count('SELECT COUNT(*) AS count FROM users WHERE disabled_at IS NOT NULL'),
        anonymizedUsers: count('SELECT COUNT(*) AS count FROM users WHERE anonymized_at IS NOT NULL'),
        activeSessions: count('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?', nowIso()),
        lists: count('SELECT COUNT(*) AS count FROM lists'),
        listMemberships: count('SELECT COUNT(*) AS count FROM list_members'),
        savedAlbums: count('SELECT COUNT(*) AS count FROM list_albums'),
        tracks: count('SELECT COUNT(*) AS count FROM album_tracks'),
        completions: count('SELECT COUNT(*) AS count FROM album_completions'),
        ratings: count('SELECT COUNT(*) AS count FROM track_ratings'),
        activityRecords: count('SELECT COUNT(*) AS count FROM user_album_activity'),
        cachedExploreCovers: count('SELECT COUNT(*) AS count FROM explore_album_covers')
      },
      recentSignups: db
        .prepare(
          `SELECT id, username, created_at, disabled_at, anonymized_at
           FROM users
           ORDER BY datetime(created_at) DESC, id DESC
           LIMIT 8`
        )
        .all(),
      recentSavedAlbums: db
        .prepare(
          `SELECT la.id, la.title, la.artist, la.created_at, u.id AS user_id, u.username
           FROM list_albums la
           LEFT JOIN users u ON u.id = la.created_by
           ORDER BY datetime(la.created_at) DESC, la.id DESC
           LIMIT 8`
        )
        .all(),
      recentActivity: db
        .prepare(
          `SELECT activity.album_key, activity.title, activity.artist, activity.completed_at, activity.rated_at, activity.updated_at,
                  u.id AS user_id, u.username
           FROM user_album_activity activity
           JOIN users u ON u.id = activity.user_id
           ORDER BY datetime(activity.updated_at) DESC
           LIMIT 8`
        )
        .all(),
      recentActions: recentActions(8)
    });
  })
);

app.get(
  '/api/accounts',
  route((req, res) => {
    res.json({ accounts: listAccounts(req.query.q, req.query.limit) });
  })
);

app.get(
  '/api/actions',
  route((req, res) => {
    res.json({ actions: recentActions(20) });
  })
);

app.post(
  '/api/accounts/:id/disable',
  route((req, res) => {
    const account = disableAccount(Number(req.params.id), req.body?.reason);
    res.json({ account, message: `${account.username} is disabled.` });
  })
);

app.post(
  '/api/accounts/:id/enable',
  route((req, res) => {
    const account = enableAccount(Number(req.params.id));
    res.json({ account, message: `${account.username} is enabled.` });
  })
);

app.post(
  '/api/accounts/:id/anonymize',
  route((req, res) => {
    const account = anonymizeAccount(Number(req.params.id));
    res.json({ account, message: `Account anonymized as ${account.username}.` });
  })
);

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: {
      message: status >= 500 ? 'Something went wrong.' : err.message,
      status
    }
  });
});

const server = app.listen(config.adminPort, config.adminHost, () => {
  console.log(`Albums admin listening on http://${config.adminHost}:${config.adminPort}`);
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
