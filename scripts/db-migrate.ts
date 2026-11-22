// `bun run db:migrate`: applies the pending SQL migrations in drizzle/ to the configured database (decision 027), then sets the application
// role's privileges (decision 055). NODE_ENV=test selects DATABASE_URL_TEST. The API and the worker never migrate on boot; run this at deploy time.
// It connects as the owner of the tables: in production that is DATABASE_OWNER_URL, which only the migrate service holds.
import { loadConfigOrExit } from '../src/config';
import { applyApplicationGrants } from '../src/infra/db/grants';
import { migrateDatabase } from '../src/infra/db/migrate';
import { databaseUrlFor, ownerUrlFor } from '../src/infra/db/url';

const config = loadConfigOrExit();
if (config.isProduction && config.database.ownerUrl === undefined) {
  console.error(
    "db:migrate in production needs DATABASE_OWNER_URL (the owner role of the tables); DATABASE_URL is the application's own role (docs/OPERATIONS.md section 3).",
  );
  process.exit(1);
}
const ownerUrl = ownerUrlFor(config);
const appUrl = databaseUrlFor(config);
const target = new URL(ownerUrl);

console.log(`Migrating ${target.hostname}:${target.port || '5432'}${target.pathname} ...`);
try {
  // Say what happened: "up to date" alone hid that migrations had just been applied (2026-11-11).
  const applied = await migrateDatabase(ownerUrl);
  console.log(
    applied === 0
      ? 'Already up to date: no migration to apply.'
      : `Applied ${applied} migration(s); the database is up to date.`,
  );
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// The migrations stay applied when this step fails; run the command again after fixing the cause.
try {
  const grants = await applyApplicationGrants(ownerUrl, appUrl);
  if (grants.kind === 'same_role') {
    if (config.isProduction) {
      console.error(
        'DATABASE_URL and DATABASE_OWNER_URL name the same role: in production the application connects with a role of its own (docs/OPERATIONS.md section 2).',
      );
      process.exit(1);
    }
    console.log(`The application connects as the owner role ${grants.role}: no grants applied.`);
  } else {
    console.log(
      `Application role ${grants.role}: ${grants.created ? 'created' : 'updated'}; privileges set on ${grants.tables} tables (no UPDATE or DELETE on the 4 append-only tables).`,
    );
  }
} catch (error) {
  console.error(`Grants failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
