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

/**
 * Picks the connection string of the owner role of the tables.
 *
 * Why: decision 055: `db:migrate` and `setup` change the schema and set up the application role, which the application's own role
 * cannot do. In production the migrate service holds `DATABASE_OWNER_URL`; elsewhere an unset one means `DATABASE_URL` (the owner is
 * the only role), and under `NODE_ENV=test` it is the test database, like every other connection of a test run.
 *
 * @param config the process configuration
 * @returns `database.testUrl` under test, otherwise `database.ownerUrl` when set, otherwise `database.url`
 */
export function ownerUrlFor(config: AppConfig): string {
  if (config.env === 'test') return config.database.testUrl;
  return config.database.ownerUrl ?? config.database.url;
}
