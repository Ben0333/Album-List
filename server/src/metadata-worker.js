import { config } from '@albums/shared/config';
import {
  claimNextMetadataJob,
  completeMetadataJob,
  failMetadataJob,
  recoverStaleMetadataJobs
} from './metadata-jobs.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProviderLimiter(minIntervalMs = 750) {
  let nextAt = 0;
  let chain = Promise.resolve();
  return async function waitForProviderSlot() {
    const task = chain.then(async () => {
      const waitMs = Math.max(0, nextAt - Date.now());
      if (waitMs) await delay(waitMs);
      nextAt = Date.now() + minIntervalMs;
    });
    chain = task.catch(() => {});
    return task;
  };
}

function logMetadataJob(event, job, extra = {}) {
  console.log(
    JSON.stringify({
      event,
      jobId: job?.id ?? null,
      jobKey: job?.job_key ?? '',
      kind: job?.kind ?? '',
      albumKey: job?.album_key ?? '',
      attempts: job?.attempts ?? 0,
      ...extra
    })
  );
}

export function createMetadataWorker({ handlers = {}, onBootPrune = null } = {}) {
  const waitForProviderSlot = createProviderLimiter();
  const active = new Set();
  let timer = null;
  let stopping = false;
  let started = false;

  async function runJob(job) {
    const startedAt = Date.now();
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`No metadata job handler registered for ${job.kind}.`);
      await waitForProviderSlot();
      await handler(job);
      completeMetadataJob(job.id);
      logMetadataJob('metadata_job_success', job, { durationMs: Date.now() - startedAt });
    } catch (error) {
      const finalFailure = failMetadataJob(job, error);
      logMetadataJob('metadata_job_failure', job, {
        durationMs: Date.now() - startedAt,
        final: finalFailure,
        error: String(error?.message || error || 'Metadata job failed.').slice(0, 1000)
      });
    }
  }

  function maybeStartJobs() {
    if (stopping) return;
    while (active.size < config.metadataWorkerConcurrency) {
      const job = claimNextMetadataJob();
      if (!job) break;
      const promise = runJob(job).finally(() => {
        active.delete(promise);
        if (!stopping) queueMicrotask(maybeStartJobs);
      });
      active.add(promise);
    }
  }

  function poll() {
    maybeStartJobs();
    if (!stopping) timer = setTimeout(poll, config.metadataWorkerPollMs);
  }

  function start() {
    if (started || !config.metadataWorkerEnabled) return;
    started = true;
    const recovered = recoverStaleMetadataJobs();
    if (recovered) {
      console.log(JSON.stringify({ event: 'metadata_jobs_recovered', count: recovered }));
    }
    if (onBootPrune) {
      try {
        const pruned = onBootPrune();
        if (pruned?.evictedCount) {
          console.log(JSON.stringify({ event: 'local_cover_cache_pruned', evictedCount: pruned.evictedCount }));
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'local_cover_cache_prune_failure', error: String(error?.message || error) }));
      }
    }
    poll();
    console.log(
      JSON.stringify({
        event: 'metadata_worker_started',
        concurrency: config.metadataWorkerConcurrency,
        pollMs: config.metadataWorkerPollMs
      })
    );
  }

  async function stop() {
    stopping = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await Promise.allSettled([...active]);
    console.log(JSON.stringify({ event: 'metadata_worker_stopped' }));
  }

  return {
    start,
    stop,
    get activeCount() {
      return active.size;
    }
  };
}
