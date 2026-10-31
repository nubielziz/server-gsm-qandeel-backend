// `bun run db:migrate`: applies the pending SQL migrations in drizzle/ to the configured database (decision 027).
// NODE_ENV=test selects DATABASE_URL_TEST. The API and the worker never migrate on boot; run this at deploy time.
import { loadConfigOrExit } from '../src/config';
import { migrateDatabase } from '../src/infra/db/migrate';
import { databaseUrlFor } from '../src/infra/db/url';

const config = loadConfigOrExit();
const url = databaseUrlFor(config);
const target = new URL(url);

console.log(`Migrating ${target.hostname}:${target.port || '5432'}${target.pathname} ...`);
try {
  await migrateDatabase(url);
  console.log('Migrations are up to date.');
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
