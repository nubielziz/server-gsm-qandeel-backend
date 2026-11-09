// The development seed as a function: loads the frontend's demo state into the configured database and gives the demo staff and
// customers their development credentials. Called by `bun run db:seed` (index.ts) and `bun run db:reset --seed` (P4b).
import type { AppConfig } from '../../src/config';
import { createDrizzle, createPool } from '../../src/infra/db';
import { databaseUrlFor } from '../../src/infra/db/url';
import { frontendDir, loadDemoState } from './demo-state';
import { seedCustomerDevCredentials } from './customers';
import { seedDevCredentials } from './dev-credentials';
import { runSeed } from './run';

/**
 * Seeds the demo into the database of the configuration and prints one line per table.
 *
 * Why: the seed command and the fresh-start command must do the same thing, so the work lives in one function. The caller
 * has already refused production (the seed is for development databases only).
 *
 * Side effects: writes the demo rows (idempotent: rows that exist are skipped); in development also the sign-in credentials of
 * the demo staff and customers; prints to stdout.
 *
 * @param config the application configuration (development or test)
 * @throws {Error} when the demo state is missing or a table does not exist yet (the migrations have not run)
 */
export async function seedDevelopmentDatabase(config: AppConfig): Promise<void> {
  const url = databaseUrlFor(config);
  const target = new URL(url);
  console.log(`Seeding ${target.hostname}:${target.port || '5432'}${target.pathname} from ${frontendDir()} ...`);

  const pool = createPool(url, 2);
  try {
    const db = createDrizzle(pool);
    const reports = await runSeed(db, await loadDemoState(), config);
    // Development only (the seed refuses production): `demo-password` and a fixed TOTP secret per seeded member (README "Local sign-in").
    if (config.env === 'development') {
      reports.push({ module: 'identity', ...(await db.transaction((tx) => seedDevCredentials(tx, config))) });
      reports.push({ module: 'customers', ...(await db.transaction((tx) => seedCustomerDevCredentials(tx, config))) });
    }
    for (const report of reports) {
      console.log(
        `  ${report.module.padEnd(9)} ${report.table.padEnd(16)} ${report.inserted} new, ${report.existing} already there`,
      );
    }
    console.log('Seed finished.');
  } finally {
    await pool.end();
  }
}
