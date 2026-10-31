// The migrator (decision 027): applies drizzle/*.sql with the drizzle-orm migrator under an advisory lock.
// Called by `bun run db:migrate` and by the test support; the API and worker never migrate on boot.
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/** The folder drizzle-kit writes migrations to (`drizzle/` at the repository root). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/** Advisory lock key held while migrating, so two processes never run migrations at the same time. */
const MIGRATION_LOCK_KEY = 7_315_200_001;

/**
 * Applies every migration that has not run yet to the database at `url`.
 *
 * Why: decision 027: schema changes ship as committed SQL (drizzle-kit) and are applied explicitly, never on boot. The
 * advisory lock makes a second concurrent run wait instead of racing (two deploy hosts, or parallel test files).
 *
 * Side effects: creates the `drizzle.__drizzle_migrations` table on first use and runs the pending SQL files in order.
 *
 * @param url the Postgres connection string of the target database
 * @param folder the migrations folder (defaults to the repository's `drizzle/`)
 * @throws {Error} when the database is unreachable or a migration fails (the failing migration is rolled back)
 */
export async function migrateDatabase(url: string, folder: string = MIGRATIONS_FOLDER): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => undefined);
  try {
    // One dedicated connection: the session-level advisory lock, the migrations and the unlock share it.
    const client = await pool.connect();
    try {
      await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      try {
        await migrate(drizzle(client), { migrationsFolder: folder });
      } finally {
        await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
