// The `postgres` health indicator (decision 015): a trivial query on the shared pool, critical for the API.
import type { HealthIndicator } from '../health';
import type { DbService } from './db.service';

/**
 * Health indicator for Postgres.
 *
 * Why: the console and load balancers read Postgres state from `GET /health` (map B11); when it is down the whole status
 * is `down` because the API cannot work without it.
 */
export class PostgresHealthIndicator implements HealthIndicator {
  readonly name = 'postgres';
  readonly critical = true;

  constructor(private readonly db: Pick<DbService, 'ping'>) {}

  /**
   * Runs `select 1`.
   *
   * @throws {Error} when Postgres does not answer; `HealthService` turns it into `down` and logs the reason
   */
  async check(): Promise<void> {
    await this.db.ping();
  }
}
