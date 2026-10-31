// Which Postgres database a process uses: the test database under NODE_ENV=test, the normal one otherwise (decision 014).
import type { AppConfig } from '../../config';

/**
 * Picks the connection string for the current mode.
 *
 * Why: decision 014: integration tests run against `gsm_test` (`DATABASE_URL_TEST`), so a test run can never touch the
 * development database even when both URLs are configured.
 *
 * @param config the process configuration
 * @returns `database.testUrl` when `NODE_ENV=test`, otherwise `database.url`
 */
export function databaseUrlFor(config: AppConfig): string {
  return config.env === 'test' ? config.database.testUrl : config.database.url;
}
