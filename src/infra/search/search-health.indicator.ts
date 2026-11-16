// The `search` health indicator (feature 29, plan section 3.4): the engine answers /health within 1 s, has no resource error, and the
// services alias of the running schema version exists. Non-critical: search falls back to Postgres when it is down.
import type { HealthIndicator } from '../health';
import type { TypesenseClient } from './typesense-client';

const ALIAS_TIMEOUT_MS = 1_000;

/**
 * Health indicator for the search engine.
 *
 * Why: the System health page shows the engine (component `search`, "Search engine"); the shop keeps working on the Postgres fallback
 * while it is down, so it never makes the status `down` (`critical: false`). A node that refuses writes for lack of disk still
 * answers `/health` with `ok: true` and a `resource_error` (step 0): that counts as a failure here. A missing alias means the index
 * is not ready (a deploy with a new schema version, a wiped volume) and fails the check too.
 *
 * Side effects: two engine calls per check (`GET /health`, `GET /aliases/:name`).
 */
export class SearchHealthIndicator implements HealthIndicator {
  readonly name = 'search';
  readonly critical = false;

  /**
   * @param client the process's engine client
   * @param alias the services alias of the running schema version (`<prefix>services_v<N>`)
   */
  constructor(
    private readonly client: Pick<TypesenseClient, 'health' | 'getAlias'>,
    private readonly alias: string,
  ) {}

  /**
   * Checks the engine.
   *
   * @returns false when the node reports a resource error or the alias is missing
   * @throws {Error} when the node does not answer; `HealthService` turns it into `down`
   */
  async check(): Promise<boolean> {
    const health = await this.client.health();
    if (!health.ok || health.resourceError !== null) return false;
    return (await this.client.getAlias(this.alias, { timeoutMs: ALIAS_TIMEOUT_MS })) !== null;
  }
}
