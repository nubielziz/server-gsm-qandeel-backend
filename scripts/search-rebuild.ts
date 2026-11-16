// `bun scripts/search-rebuild.ts`: asks the worker to rebuild the storefront search index now (feature 29, plan section 4.5): one
// `search_rebuild` job on the `maintenance` queue, the same job the nightly schedule and the console's "Rebuild index" start, so the
// rebuild keeps its lock, its `job_runs` row and its follow-up reconcile. Used by the seed too (scripts/seed/run.ts).
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { type AppConfig, loadConfigOrExit } from '../src/config';
import { defaultJobOptions, queueJobId } from '../src/infra/queues';
import { SEARCH_JOBS } from '../src/modules/storefront';
import { scriptClient } from './search-keys';

/** What the request did. */
export interface RebuildRequest {
  readonly queued: boolean;
  /** The job id when queued, else why not. */
  readonly detail: string;
}

/**
 * Queues one rebuild when search is on and the engine answers.
 *
 * Why: decision 038: the rebuild runs in the worker (the one place with the indexer key and the rebuild lock); a script only asks for
 * it. With search off, or the engine down, nothing is queued: the worker's boot reconcile rebuilds an index without an alias anyway.
 *
 * @param config the configuration of the environment
 * @param origin what asked (`cli`, `seed`): part of the job id
 * @param at the moment of the request (the job id's stamp)
 * @returns whether a job was queued
 */
export async function requestSearchRebuild(config: AppConfig, origin: string, at: Date): Promise<RebuildRequest> {
  if (!config.search.enabled) return { queued: false, detail: 'search is off (SEARCH_ENABLED=false)' };
  const health = await scriptClient(config.search.url, config.search.indexerKey ?? '')
    .health()
    .catch(() => null);
  if (!health?.ok)
    return { queued: false, detail: `the search engine at ${new URL(config.search.url).host} does not answer` };
  const connection = new Redis(config.redis.queueUrl, {
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  connection.on('error', () => undefined);
  const queue = new Queue('maintenance', {
    connection,
    prefix: config.redis.bullPrefix,
    defaultJobOptions: defaultJobOptions('maintenance'),
  });
  queue.on('error', () => undefined);
  try {
    // The queue connects the lazy client itself; a second connect() would throw "Redis is already connecting/connected".
    await queue.waitUntilReady();
    const jobId = queueJobId(
      'rebuild',
      origin,
      at
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14),
    );
    await queue.add(SEARCH_JOBS.rebuild, { reason: origin }, { jobId });
    return { queued: true, detail: jobId };
  } finally {
    await queue.close().catch(() => undefined);
    connection.disconnect();
  }
}

if (import.meta.main) {
  const config = loadConfigOrExit();
  try {
    const outcome = await requestSearchRebuild(config, 'cli', new Date());
    console.log(
      outcome.queued
        ? `A rebuild of the search index was queued (job ${outcome.detail}); the worker runs it.`
        : `No rebuild was queued: ${outcome.detail}.`,
    );
  } catch (error) {
    console.error(`The rebuild could not be queued: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
