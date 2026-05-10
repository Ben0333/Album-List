import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return value;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function count(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.count || 0);
}

const databasePath = path.resolve(process.cwd(), requireEnv('DATABASE_PATH'));
const testPrefix = requireEnv('TEST_PREFIX');

if (testPrefix.length < 6) {
  console.error('TEST_PREFIX must be at least 6 characters so cleanup cannot match broad real data.');
  process.exit(1);
}

if (process.env.CONFIRM_CLEANUP !== 'true') {
  console.error('Refusing cleanup without CONFIRM_CLEANUP=true.');
  process.exit(1);
}

if (!fs.existsSync(databasePath)) {
  console.error(`Database does not exist: ${databasePath}`);
  process.exit(1);
}

const likePrefix = `${escapeLike(testPrefix)}%`;
const db = new DatabaseSync(databasePath);

try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  const matchingUsersWhere = '(username LIKE ? ESCAPE ? OR email LIKE ? ESCAPE ?)';
  const before = {
    users: count(db, `SELECT COUNT(*) AS count FROM users WHERE ${matchingUsersWhere}`, likePrefix, '\\', likePrefix, '\\'),
    lists: count(db, 'SELECT COUNT(*) AS count FROM lists WHERE name LIKE ? ESCAPE ?', likePrefix, '\\'),
    reports: count(
      db,
      `SELECT COUNT(*) AS count
       FROM bug_reports
       WHERE title LIKE ? ESCAPE ?
          OR description LIKE ? ESCAPE ?
          OR user_id IN (SELECT id FROM users WHERE ${matchingUsersWhere})`,
      likePrefix,
      '\\',
      likePrefix,
      '\\',
      likePrefix,
      '\\',
      likePrefix,
      '\\'
    )
  };

  console.log(JSON.stringify({ event: 'cleanup_preview', databasePath, testPrefix, before }, null, 2));

  db.exec('BEGIN IMMEDIATE');
  try {
    const reports = db
      .prepare(
        `DELETE FROM bug_reports
         WHERE title LIKE ? ESCAPE ?
            OR description LIKE ? ESCAPE ?
            OR user_id IN (SELECT id FROM users WHERE ${matchingUsersWhere})`
      )
      .run(likePrefix, '\\', likePrefix, '\\', likePrefix, '\\', likePrefix, '\\').changes;
    const lists = db.prepare('DELETE FROM lists WHERE name LIKE ? ESCAPE ?').run(likePrefix, '\\').changes;
    const users = db.prepare(`DELETE FROM users WHERE ${matchingUsersWhere}`).run(likePrefix, '\\', likePrefix, '\\').changes;
    db.exec('COMMIT');
    console.log(JSON.stringify({ event: 'cleanup_complete', deleted: { reports, lists, users } }, null, 2));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
} finally {
  db.close();
}
