import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

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

function parseAdminHost(value) {
  const host = String(value || '127.0.0.1').trim().toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('ADMIN_HOST must be localhost, 127.0.0.1, or ::1.');
  }
  return host;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const appOrigin = parseAppOrigin(process.env.APP_ORIGIN || 'http://localhost:3000');
const cookieSecure = parseBoolean(process.env.COOKIE_SECURE, nodeEnv === 'production');
const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/albums.sqlite');

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: parsePositiveInteger('PORT', process.env.PORT, 3000, { min: 1, max: 65535 }),
  adminPort: parsePositiveInteger('ADMIN_PORT', process.env.ADMIN_PORT, 3001, { min: 1, max: 65535 }),
  adminHost: parseAdminHost(process.env.ADMIN_HOST),
  appOrigin,
  allowedOrigins: [appOrigin],
  cookieName: process.env.SESSION_COOKIE_NAME || 'albums_sid',
  sessionDays: parsePositiveInteger('SESSION_DAYS', process.env.SESSION_DAYS, 30, { min: 1, max: 90 }),
  cookieSecure,
  trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  databasePath
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
