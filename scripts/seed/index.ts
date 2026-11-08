// `bun run db:seed`: loads the frontend's demo state into the development database (decision 014: seed = frontend mocks).
// Development only: it refuses NODE_ENV=production. Idempotent: rows that exist are skipped. NODE_ENV=test seeds gsm_test.
import { loadConfigOrExit } from '../../src/config';
import { createDrizzle, createPool } from '../../src/infra/db';
import { databaseUrlFor } from '../../src/infra/db/url';
import { frontendDir, loadDemoState } from './demo-state';
import { seedCustomerDevCredentials } from './customers';
import { seedDevCredentials } from './dev-credentials';
import { runSeed } from './run';

// The first check reads the raw variable on purpose: a production environment must be refused before its (possibly
// incomplete) configuration is even validated.
if (process.env.NODE_ENV === 'production') {
  console.error('db:seed is for development only and refuses NODE_ENV=production.');
  process.exit(1);
}
const config = loadConfigOrExit();
if (config.isProduction) {
  console.error('db:seed is for development only and refuses a production configuration.');
  process.exit(1);
}

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
} catch (error) {
  // 42P01 is "relation does not exist": the migrations have not run.
  const missing =
    (error as { cause?: { code?: string } }).cause?.code === '42P01' || (error as { code?: string }).code === '42P01';
  console.error(missing ? 'The tables do not exist yet. Run `bun run db:migrate` first.' : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
