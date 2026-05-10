import crypto from 'node:crypto';
import { db, nowIso, transaction } from '@albums/shared/db';
import { config } from '@albums/shared/config';
import { markHydrationJobStatus } from './hydration-status.js';

export const metadataJobKinds = new Set(['album_metadata', 'cover', 'tracklist', 'explore_cover']);
export const metadataJobStatuses = new Set(['queued', 'running', 'done', 'failed']);

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function boundedPriority(value) {
  const priority = Number(value ?? 50);
  if (!Number.isInteger(priority)) return 50;
  return Math.min(1000, Math.max(0, priority));
}

function hashText(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

export function metadataJobKey(kind, { albumKey = '', providerId = '', sourceContext = '', dedupeKey = '' } = {}) {
  const basis = dedupeKey || `${albumKey}\n${providerId}\n${sourceContext}`;
  return `${kind}:${hashText(basis)}`;
}

function normalizeJobInput(job) {
  const kind = clampText(job?.kind, 40);
  if (!metadataJobKinds.has(kind)) throw new Error(`Unsupported metadata job kind: ${kind || '(empty)'}`);
  const albumKey = clampText(job?.albumKey ?? job?.album_key, 320);
  const title = clampText(job?.title, 160);
  if (!albumKey || !title) throw new Error('Metadata jobs require albumKey and title.');
  const artist = clampText(job?.artist, 160);
  const providerId = clampText(job?.providerId ?? job?.provider_id, 220);
  const sourceContext = clampText(job?.sourceContext ?? job?.source_context, 240);
  const priority = boundedPriority(job?.priority);
  const jobKey = clampText(job?.jobKey ?? job?.job_key, 140) || metadataJobKey(kind, {
    albumKey,
    providerId,
    sourceContext,
    dedupeKey: job?.dedupeKey
  });
  return {
    kind,
    albumKey,
    title,
    artist,
    providerId,
    sourceContext,
    priority,
    jobKey
  };
}

export function enqueueMetadataJob(job, options = {}) {
  const input = normalizeJobInput(job);
  const force = options.force === true ? 1 : 0;
  const queuedAt = nowIso();
  db.prepare(
    `INSERT INTO metadata_jobs
       (job_key, kind, album_key, title, artist, provider_id, source_context, priority, status, available_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
     ON CONFLICT(job_key) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       provider_id = CASE
         WHEN excluded.provider_id != '' THEN excluded.provider_id
         ELSE metadata_jobs.provider_id
       END,
       source_context = CASE
         WHEN excluded.source_context != '' THEN excluded.source_context
         ELSE metadata_jobs.source_context
       END,
       priority = MIN(metadata_jobs.priority, excluded.priority),
       status = CASE
         WHEN ? = 1 OR metadata_jobs.status = 'failed' THEN 'queued'
         ELSE metadata_jobs.status
       END,
       attempts = CASE
         WHEN ? = 1 THEN 0
         ELSE metadata_jobs.attempts
       END,
       last_error = CASE
         WHEN ? = 1 OR metadata_jobs.status = 'failed' THEN ''
         ELSE metadata_jobs.last_error
       END,
       available_at = CASE
         WHEN ? = 1 OR metadata_jobs.status = 'failed' THEN excluded.available_at
         WHEN metadata_jobs.status = 'queued' AND excluded.priority < metadata_jobs.priority THEN excluded.available_at
         ELSE metadata_jobs.available_at
       END,
       locked_at = CASE
         WHEN ? = 1 OR metadata_jobs.status = 'failed' THEN NULL
         ELSE metadata_jobs.locked_at
       END,
       updated_at = excluded.updated_at`
  ).run(
    input.jobKey,
    input.kind,
    input.albumKey,
    input.title,
    input.artist,
    input.providerId,
    input.sourceContext,
    input.priority,
    queuedAt,
    queuedAt,
    queuedAt,
    force,
    force,
    force,
    force,
    force
  );
  const status = db.prepare('SELECT status FROM metadata_jobs WHERE job_key = ?').get(input.jobKey)?.status || 'queued';
  if (status === 'queued' || status === 'running') {
    markHydrationJobStatus(input, status === 'running' ? 'hydrating' : 'queued');
  }
  return input.jobKey;
}

export function enqueueMetadataJobs(jobs, options = {}) {
  const keys = [];
  transaction(() => {
    for (const job of jobs || []) keys.push(enqueueMetadataJob(job, options));
  })();
  return keys;
}

export const recoverStaleMetadataJobs = transaction((staleBeforeIso) => {
  const cutoff = staleBeforeIso || new Date(Date.now() - 10 * 60 * 1000).toISOString();
  return db
    .prepare(
      `UPDATE metadata_jobs
       SET status = 'queued',
           locked_at = NULL,
           available_at = ?,
           updated_at = ?,
           last_error = CASE
             WHEN last_error = '' THEN 'Recovered stale running job.'
             ELSE last_error
           END
       WHERE status = 'running'
         AND (locked_at IS NULL OR locked_at < ?)`
    )
    .run(nowIso(), nowIso(), cutoff).changes;
});

export const claimNextMetadataJob = transaction(() => {
  const availableAt = nowIso();
  const row = db
    .prepare(
      `SELECT *
       FROM metadata_jobs
       WHERE status = 'queued'
         AND available_at <= ?
       ORDER BY priority ASC, available_at ASC, id ASC
       LIMIT 1`
    )
    .get(availableAt);
  if (!row) return null;

  const lockedAt = nowIso();
  const result = db
    .prepare(
      `UPDATE metadata_jobs
       SET status = 'running',
           locked_at = ?,
           attempts = attempts + 1,
           updated_at = ?
       WHERE id = ?
         AND status = 'queued'`
    )
    .run(lockedAt, lockedAt, row.id);
  if (!result.changes) return null;
  const claimed = {
    ...row,
    status: 'running',
    locked_at: lockedAt,
    attempts: Number(row.attempts || 0) + 1
  };
  markHydrationJobStatus(claimed, 'hydrating');
  return claimed;
});

export function completeMetadataJob(jobId) {
  db.prepare(
    `UPDATE metadata_jobs
     SET status = 'done',
         locked_at = NULL,
         last_error = '',
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), jobId);
}

function retryAvailableAt(attempts) {
  const retryIndex = Math.max(0, Number(attempts || 1) - 1);
  const delayMs = Math.min(60 * 60 * 1000, Math.round(1500 * 2 ** retryIndex));
  return new Date(Date.now() + delayMs).toISOString();
}

export function failMetadataJob(job, error) {
  const attempts = Number(job?.attempts || 0);
  const finalFailure = attempts >= config.metadataJobMaxAttempts;
  const message = clampText(error?.message || error || 'Metadata job failed.', 1000);
  db.prepare(
    `UPDATE metadata_jobs
     SET status = ?,
         locked_at = NULL,
         last_error = ?,
         available_at = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    finalFailure ? 'failed' : 'queued',
    message,
    finalFailure ? nowIso() : retryAvailableAt(attempts),
    nowIso(),
    job.id
  );
  markHydrationJobStatus(job, finalFailure ? 'failed' : 'queued', message);
  return finalFailure;
}

export function pruneMetadataJobs() {
  const cutoff = new Date(Date.now() - config.metadataJobSuccessRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM metadata_jobs WHERE status = 'done' AND updated_at < ?").run(cutoff).changes;
}

export function metadataQueueCounts() {
  const counts = Object.fromEntries([...metadataJobStatuses].map((status) => [status, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM metadata_jobs GROUP BY status').all()) {
    counts[row.status] = Number(row.count || 0);
  }
  return counts;
}

export function metadataQueueDiagnostics() {
  const counts = metadataQueueCounts();
  const oldestQueued = db
    .prepare("SELECT MIN(created_at) AS value FROM metadata_jobs WHERE status = 'queued'")
    .get()?.value || null;
  const newestUpdated = db.prepare('SELECT MAX(updated_at) AS value FROM metadata_jobs').get()?.value || null;
  return {
    counts,
    oldestQueued,
    newestUpdated,
    maxAttempts: config.metadataJobMaxAttempts
  };
}

export function hasPendingMetadataHydration(albumKeyValue) {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM metadata_jobs
         WHERE album_key = ?
           AND kind IN ('album_metadata', 'tracklist')
           AND status IN ('queued', 'running')
         LIMIT 1`
      )
      .get(albumKeyValue)
  );
}
