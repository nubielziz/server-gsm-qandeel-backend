// `bun run db:seed`: loads the frontend's demo state into the development database (decision 014: seed = frontend mocks).
// Development only: it refuses NODE_ENV=production and a database that is not on this machine (decision 055). Idempotent: rows that exist are skipped. NODE_ENV=test seeds gsm_test.
import { loadConfigOrExit } from '../../src/config';
import { seedDevelopmentDatabase } from './dev-seed';
import { seedRefusal } from './seed-guard';

// The first check reads the raw variable on purpose: a production environment must be refused before its (possibly
// incomplete) configuration is even validated.
if (process.env.NODE_ENV === 'production') {
  console.error('db:seed is for development only and refuses NODE_ENV=production.');
  process.exit(1);
}
const config = loadConfigOrExit();
const refusal = seedRefusal(config);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(1);
}

try {
  await seedDevelopmentDatabase(config);
} catch (error) {
  // 42P01 is "relation does not exist": the migrations have not run.
  const missing =
    (error as { cause?: { code?: string } }).cause?.code === '42P01' || (error as { code?: string }).code === '42P01';
  console.error(missing ? 'The tables do not exist yet. Run `bun run db:migrate` first.' : error);
  process.exitCode = 1;
}
