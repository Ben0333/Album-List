import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config();
dotenv.config({ path: path.join(repoRoot, '.env'), override: false });

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

function parseAppOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.origin;
  } catch {
    throw new Error('APP_ORIGIN must be a valid http:// or https:// origin.');
  }
}

function isLocalOrigin(origin) {
  const hostname = new URL(origin).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

const nodeEnv = process.env.NODE_ENV || 'development';
const appOrigin = parseAppOrigin(process.env.APP_ORIGIN || 'http://localhost:3000');
const cookieSecure = parseBoolean(process.env.COOKIE_SECURE, nodeEnv === 'production');
const databasePath = path.resolve(repoRoot, process.env.DATABASE_PATH || './data/albums.sqlite');
const localCoverCacheDir = path.resolve(repoRoot, process.env.LOCAL_COVER_CACHE_DIR || './data/covers');

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: parsePositiveInteger('PORT', process.env.PORT, 3000, { min: 1, max: 65535 }),
  appOrigin,
  allowedOrigins: [appOrigin],
  cookieName: process.env.SESSION_COOKIE_NAME || 'albums_sid',
  sessionDays: parsePositiveInteger('SESSION_DAYS', process.env.SESSION_DAYS, 30, { min: 1, max: 90 }),
  cookieSecure,
  trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  databasePath,
  metadataWorkerEnabled: parseBoolean(process.env.METADATA_WORKER_ENABLED, true),
  metadataWorkerPollMs: parsePositiveInteger('METADATA_WORKER_POLL_MS', process.env.METADATA_WORKER_POLL_MS, 1500, {
    min: 250,
    max: 60_000
  }),
  metadataWorkerConcurrency: parsePositiveInteger(
    'METADATA_WORKER_CONCURRENCY',
    process.env.METADATA_WORKER_CONCURRENCY,
    1,
    {
      min: 1,
      max: 8
    }
  ),
  localCoverCacheDir,
  maxLocalCoverImages: parsePositiveInteger('MAX_LOCAL_COVER_IMAGES', process.env.MAX_LOCAL_COVER_IMAGES, 5000, {
    min: 1,
    max: 1_000_000
  }),
  maxLocalCoverBytes: parsePositiveInteger('MAX_LOCAL_COVER_BYTES', process.env.MAX_LOCAL_COVER_BYTES, 12_000_000_000, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER
  }),
  metadataJobMaxAttempts: parsePositiveInteger('METADATA_JOB_MAX_ATTEMPTS', process.env.METADATA_JOB_MAX_ATTEMPTS, 5, {
    min: 1,
    max: 50
  })
};

function validateProductionConfig() {
  if (!config.isProduction) return;

  const failures = [];
  if (!process.env.APP_ORIGIN) failures.push('APP_ORIGIN is required in production.');
  if (!config.appOrigin.startsWith('https://')) failures.push('APP_ORIGIN must use https:// in production.');
  if (isLocalOrigin(config.appOrigin)) failures.push('APP_ORIGIN must not point at localhost in production.');
  if (!config.cookieSecure) failures.push('COOKIE_SECURE=true is required in production.');
  if (!process.env.DATABASE_PATH) failures.push('DATABASE_PATH must be set explicitly in production.');
  if (config.databasePath.includes(`${path.sep}tmp${path.sep}`)) failures.push('DATABASE_PATH must not point at a temporary directory.');

  if (failures.length) {
    throw new Error(`Unsafe production configuration:\n- ${failures.join('\n- ')}`);
  }
}

validateProductionConfig();
