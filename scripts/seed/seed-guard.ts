// The refusals of `bun run db:seed` (decision 055), pure so a test proves each without a process or a database.
import { type AppConfig, databaseIsLocal } from '../../src/config';
import { databaseUrlFor } from '../../src/infra/db/url';

/**
 * Judges whether the development seed may run on this configuration.
 *
 * Why: the seed fills a database with fake customers, merchants, orders and a known owner login, so it only ever runs on a
 * development configuration and on a database on this machine (decision 055; production is also refused from the raw variable
 * before the configuration is read, see `index.ts`).
 *
 * @param config the process configuration
 * @returns the message to print before exiting with code 1, or `undefined` when the seed may run
 */
export function seedRefusal(config: AppConfig): string | undefined {
  if (config.isProduction) return 'db:seed is for development only and refuses a production configuration.';
  // A URL without a host reaches the host of PGHOST, so that counts too.
  if (!databaseIsLocal(databaseUrlFor(config), config.database.driverHost)) {
    return 'db:seed only works on a database on this machine (localhost, 127.x.x.x or ::1); nothing was changed.';
  }
  return undefined;
}
