import fs from 'node:fs';
import path from 'node:path';
import { albumFixtures } from './fixtures.js';

const args = new Set(process.argv.slice(2));
const targetRequired = args.has('--target-required');
const smokeMode = args.has('--smoke');

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function envNumber(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return parsed;
}

function safePrefix(value) {
  const cleaned = String(value || 'loadtest').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 14);
  return cleaned.length >= 3 ? cleaned : 'loadtest';
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isLocalTarget(url) {
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function assertTargetAllowed(targetUrl) {
  const target = new URL(targetUrl);
  const isLocal = isLocalTarget(target);
  const allowProductionWrites = envFlag('ALLOW_PRODUCTION_WRITES', false);
  const confirmed = process.env.CONFIRM_TARGET === 'turntable';
  const isKnownProduction = target.hostname === 'turntable.graves.com.br';

  if (targetRequired && !process.env.TARGET_URL) {
    throw new Error('TARGET_URL is required for stress:target and smoke:target.');
  }

  if (!isLocal && (!allowProductionWrites || !confirmed)) {
    const productionHint = isKnownProduction ? 'Known production target detected. ' : '';
    throw new Error(
      `${productionHint}Refusing write load against non-local target ${target.origin}. ` +
        'Set ALLOW_PRODUCTION_WRITES=true and CONFIRM_TARGET=turntable only after taking a backup.'
    );
  }
}

const targetUrl = (process.env.TARGET_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
assertTargetAllowed(targetUrl);

const concurrency = envInt('CONCURRENCY', smokeMode ? 5 : 25, { min: 1, max: 1000 });
const durationSeconds = envInt('DURATION_SECONDS', smokeMode ? 30 : 60, { min: 1, max: 86_400 });
const rampSeconds = envInt('RAMP_SECONDS', smokeMode ? 5 : 15, { min: 0, max: 3600 });
const writeRatio = envNumber('WRITE_RATIO', smokeMode ? 0.15 : 0.35, { min: 0, max: 1 });
const maxRequestsPerUser = envInt('MAX_REQUESTS_PER_USER', smokeMode ? 30 : 100, { min: 1, max: 100_000 });
const requestTimeoutMs = envInt('REQUEST_TIMEOUT_MS', 10_000, { min: 500, max: 120_000 });
const testPrefix = safePrefix(process.env.TEST_PREFIX || 'loadtest');
const runStamp = timestampForFile();
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const metrics = {
  latencies: [],
  statusCounts: new Map(),
  endpointCounts: new Map(),
  errors: new Map(),
  total: 0,
  timeouts: 0,
  networkErrors: 0,
  fiveXx: 0,
  fourXxUnexpected: 0,
  fourTwoNine: 0,
  maxLatencyMs: 0
};

function count(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function record(endpoint, status, durationMs, errorCode = '') {
  const rounded = Math.round(durationMs);
  metrics.total += 1;
  metrics.latencies.push(rounded);
  metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, rounded);
  count(metrics.endpointCounts, endpoint);
  count(metrics.statusCounts, String(status || errorCode || 'error'));

  if (status === 429) metrics.fourTwoNine += 1;
  else if (status >= 500) metrics.fiveXx += 1;
  else if (status >= 400) metrics.fourXxUnexpected += 1;

  if (errorCode) count(metrics.errors, errorCode);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeUserIdentity(workerId) {
  const base = `${testPrefix}_${runId.slice(-7)}_${workerId}`;
  const username = base.slice(0, 30);
  return {
    username,
    email: `${username}@example.test`,
    password: `LoadTest!${runId}${workerId}`
  };
}

function jsonHeaders(session) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'turntable-write-load/1.0'
  };
  if (session.cookie) headers.cookie = session.cookie;
  return headers;
}

function updateCookie(session, response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return;
  const cookiePair = setCookie.split(';')[0];
  if (cookiePair.includes('=')) session.cookie = cookiePair;
}

async function request(session, method, routePath, { body, endpoint = `${method} ${routePath}` } = {}) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${targetUrl}${routePath}`, {
      method,
      headers: method === 'GET' ? { accept: '*/*', 'user-agent': 'turntable-write-load/1.0', ...(session.cookie ? { cookie: session.cookie } : {}) } : jsonHeaders(session),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal
    });
    updateCookie(session, response);

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
    record(endpoint, response.status, performance.now() - startedAt);
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'timeout' : 'network_error';
    if (code === 'timeout') metrics.timeouts += 1;
    else metrics.networkErrors += 1;
    record(endpoint, 0, performance.now() - startedAt, code);
    return { ok: false, status: 0, error };
  } finally {
    clearTimeout(timeout);
  }
}

function albumPayload(workerId, albumIndex) {
  const fixture = albumFixtures[albumIndex % albumFixtures.length];
  return {
    ...fixture,
    title: `${fixture.title} ${runId.slice(-4)}-${workerId}-${albumIndex}`,
    notes: `${testPrefix} generated stress-test album`
  };
}

async function anonymousRead(session) {
  const routes = ['/', '/api/health', '/api/explore'];
  const routePath = routes[Math.floor(Math.random() * routes.length)];
  return request(session, 'GET', routePath, { endpoint: `GET ${routePath}` });
}

async function registerUser(state) {
  const identity = makeUserIdentity(state.workerId);
  const result = await request(state, 'POST', '/api/auth/register', {
    endpoint: 'POST /api/auth/register',
    body: {
      username: identity.username,
      email: identity.email,
      password: identity.password,
      musicPlatform: 'na'
    }
  });

  if (result.ok && result.payload?.user) {
    state.user = result.payload.user;
    state.identity = identity;
    const personal = (result.payload.lists || []).find((list) => list.kind === 'personal');
    if (personal) state.personalListId = personal.id;
  }
}

async function readSession(state) {
  return request(state, 'GET', '/api/me', { endpoint: 'GET /api/me' });
}

async function createList(state) {
  const result = await request(state, 'POST', '/api/lists', {
    endpoint: 'POST /api/lists',
    body: {
      kind: 'collab',
      name: `${testPrefix} list ${runId.slice(-6)} ${state.workerId}`
    }
  });
  const createdList = result.payload?.list?.list || result.payload?.list;
  if (result.ok && createdList?.id) state.list = createdList;
}

async function addAlbum(state) {
  if (!state.list?.id) return createList(state);
  const albumIndex = state.albums.length;
  const result = await request(state, 'POST', `/api/lists/${state.list.id}/albums`, {
    endpoint: 'POST /api/lists/:id/albums',
    body: albumPayload(state.workerId, albumIndex)
  });
  if (result.ok && result.payload?.albumId) {
    state.albums.push(result.payload.albumId);
    if (result.payload.list) state.list = result.payload.list;
  }
}

async function readList(state) {
  if (!state.list?.id) return readSession(state);
  return request(state, 'GET', `/api/lists/${state.list.id}`, { endpoint: 'GET /api/lists/:id' });
}

async function completeAlbum(state) {
  if (!state.albums.length) return addAlbum(state);
  const albumId = state.albums[Math.floor(Math.random() * state.albums.length)];
  return request(state, 'POST', `/api/lists/${state.list.id}/albums/${albumId}/complete`, {
    endpoint: 'POST /api/lists/:id/albums/:albumId/complete',
    body: { completed: true }
  });
}

async function rateAlbum(state) {
  if (!state.albums.length) return addAlbum(state);
  const albumId = state.albums[Math.floor(Math.random() * state.albums.length)];
  return request(state, 'PUT', `/api/lists/${state.list.id}/albums/${albumId}/rating`, {
    endpoint: 'PUT /api/lists/:id/albums/:albumId/rating',
    body: { rating: Math.floor(Math.random() * 11), includeInAverage: true }
  });
}

async function sendMessage(state) {
  if (!state.list?.id) return createList(state);
  return request(state, 'POST', `/api/lists/${state.list.id}/messages`, {
    endpoint: 'POST /api/lists/:id/messages',
    body: { body: `${testPrefix} load-test message ${runId} ${state.workerId} ${state.requests}` }
  });
}

async function submitBugReport(state) {
  state.reported = true;
  return request(state, 'POST', '/api/reports', {
    endpoint: 'POST /api/reports',
    body: {
      body: `${testPrefix} generated load test bug report for write stress coverage`,
      path: '/load-test',
      openedAt: Date.now() - 3000,
      website: ''
    }
  });
}

async function writeStep(state) {
  if (!state.user) return registerUser(state);
  if (!state.list) return createList(state);
  if (state.albums.length < 3) return addAlbum(state);
  if (!state.reported && state.workerId % 25 === 0) return submitBugReport(state);

  const roll = Math.random();
  if (roll < 0.25) return addAlbum(state);
  if (roll < 0.5) return completeAlbum(state);
  if (roll < 0.75) return rateAlbum(state);
  return sendMessage(state);
}

async function readStep(state) {
  if (!state.user || Math.random() < 0.35) return anonymousRead(state);
  if (Math.random() < 0.35) return readSession(state);
  return readList(state);
}

async function worker(workerId, endAt) {
  const state = {
    workerId,
    cookie: '',
    user: null,
    identity: null,
    list: null,
    albums: [],
    requests: 0,
    reported: false
  };

  if (rampSeconds > 0 && concurrency > 1) {
    await delay(Math.round(((workerId - 1) / (concurrency - 1)) * rampSeconds * 1000));
  }

  while (Date.now() < endAt && state.requests < maxRequestsPerUser) {
    state.requests += 1;
    if (Math.random() < writeRatio) await writeStep(state);
    else await readStep(state);
  }
}

const startedAt = new Date();
const endAt = Date.now() + durationSeconds * 1000;

console.log(
  JSON.stringify(
    {
      event: 'stress_start',
      targetUrl,
      concurrency,
      durationSeconds,
      rampSeconds,
      writeRatio,
      maxRequestsPerUser,
      testPrefix,
      smokeMode
    },
    null,
    2
  )
);

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1, endAt)));

const endedAt = new Date();
const elapsedSeconds = Math.max(0.001, (endedAt.getTime() - startedAt.getTime()) / 1000);
const sortedLatencies = metrics.latencies.toSorted((a, b) => a - b);
const summary = {
  ok: metrics.fiveXx === 0 && metrics.timeouts === 0 && metrics.networkErrors === 0 && metrics.fourXxUnexpected === 0,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  targetUrl,
  concurrency,
  durationSeconds,
  rampSeconds,
  writeRatio,
  maxRequestsPerUser,
  testPrefix,
  smokeMode,
  totalRequests: metrics.total,
  requestsPerSecond: Math.round((metrics.total / elapsedSeconds) * 100) / 100,
  latencyMs: {
    p50: percentile(sortedLatencies, 50),
    p95: percentile(sortedLatencies, 95),
    p99: percentile(sortedLatencies, 99),
    max: metrics.maxLatencyMs
  },
  statusCounts: Object.fromEntries([...metrics.statusCounts.entries()].sort()),
  endpointCounts: Object.fromEntries([...metrics.endpointCounts.entries()].sort()),
  counts: {
    http429: metrics.fourTwoNine,
    http5xx: metrics.fiveXx,
    unexpected4xx: metrics.fourXxUnexpected,
    timeouts: metrics.timeouts,
    networkErrors: metrics.networkErrors
  },
  errors: Object.fromEntries([...metrics.errors.entries()].sort())
};

fs.mkdirSync(path.resolve(process.cwd(), 'stress-results'), { recursive: true });
const resultPath = path.resolve(process.cwd(), 'stress-results', `${runStamp}.json`);
fs.writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ event: 'stress_summary', resultPath, ...summary }, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}
