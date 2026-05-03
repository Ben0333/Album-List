import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function sqliteStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/albums.sqlite');
const outputDir = path.resolve(process.cwd(), process.env.BACKUP_DIR || './backups');
const outputPath = path.join(outputDir, `turntable-${timestamp()}.sqlite`);

if (!fs.existsSync(databasePath)) {
  console.error(`Database does not exist: ${databasePath}`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const db = new DatabaseSync(databasePath);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  db.exec(`VACUUM main INTO ${sqliteStringLiteral(outputPath)}`);
} finally {
  db.close();
}

const bytes = fs.statSync(outputPath).size;
console.log(JSON.stringify({ ok: true, databasePath, outputPath, bytes }, null, 2));
