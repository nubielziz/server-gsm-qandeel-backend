// A route that makes Postgres refuse a statement whose bound value is a marker, and logs the failure three ways (decision 054). Its own
// file: TestController is also mounted on apps without a database.
import { Controller, Logger } from '@nestjs/common';
import { z } from 'zod';
import { Route, defineRoute } from '@src/common/contract';
import { DbService, schema as s } from '@src/infra/db';
import { DB_FAILURE_MARKER } from './db-failure';

export { DB_FAILURE_MARKER } from './db-failure';

/**
 * Inserts a `job_runs` row whose `job` is the marker and whose trigger Postgres refuses (`23514`, `job_runs_trigger_check`).
 *
 * @param db the app's database service
 * @returns never: the insert always fails with a Drizzle error that carries the statement and the marker
 */
export async function insertRefusedJobRun(db: DbService): Promise<never> {
  // The trigger is outside the column's list on purpose: the check constraint refuses the row.
  await db.db.insert(s.jobRuns).values({ job: DB_FAILURE_MARKER, trigger: 'bogus' as never });
  throw new Error('Postgres accepted a job run with an unknown trigger.');
}

export const dbFailure = defineRoute({
  key: 'GET /t/db-failure',
  summary: 'Makes Postgres refuse a statement',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  success: { status: 200, schema: z.object({}) },
  errors: [],
});

/** Serves {@link dbFailure}. */
@Controller()
export class DatabaseFailureTestController {
  private readonly logger = new Logger('DatabaseFailureTest');

  constructor(private readonly db: DbService) {}

  /**
   * Fails a statement, logs the error as text, as an error and nested in an object, and rethrows it.
   *
   * @returns never
   */
  @Route(dbFailure)
  async fail(): Promise<Record<string, never>> {
    try {
      return await insertRefusedJobRun(this.db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`db failed: ${message}`);
      this.logger.error(error);
      this.logger.warn({ msg: 'nested', detail: { error } });
      throw error;
    }
  }
}
