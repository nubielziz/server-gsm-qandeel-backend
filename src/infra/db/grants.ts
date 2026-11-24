// The application's own database role and what it may do (decision 055): the grants step that `db:migrate` and `setup` run after the
// migrations, and the pure reading of the two connection URLs it works from. Connects as the owner role, never as the application.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Pool } from 'pg';

/**
 * The tables that only ever receive new rows: the ledger, the order timeline, the audit log, the map from old ids to accounts, the rank
 * history and the keys of staff wallet actions.
 *
 * Why: decision 055 and decision 024: no code updates or deletes them (the triggers refuse it too), so the application role gets no
 * `UPDATE` or `DELETE` on them and a stolen application login cannot rewrite money history. Decision 064 adds the three tables whose rows
 * are history of accounts: `account_legacy_ids`, `account_rank_changes` and `wallet_action_keys`.
 */
export const APPEND_ONLY_TABLES = [
  'ledger_entries',
  'ledger_transactions',
  'order_events',
  'audit_logs',
  'account_legacy_ids',
  'account_rank_changes',
  'wallet_action_keys',
] as const;

/** The pattern a role name must match to be quoted into a grant without surprise: lower-case letters, digits and `_`. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The characters a password may use: printable ASCII.
 *
 * Why: Postgres prepares a password with SASLprep (RFC 4013) before it derives the verifier and falls back to the raw text when the
 * preparation fails; printable ASCII passes through it unchanged, so the verifier made here is the one Postgres would make, and the
 * node driver (which does not prepare the password) signs in with the same bytes.
 */
const PASSWORD_CHARACTERS = /^[\x20-\x7e]+$/;

/**
 * Advisory lock key held for the whole grants step, so two runs at once wait for each other.
 *
 * Why: the step creates or alters a role and changes grants on every table; two runs that meet would fail on the role's unique name
 * or on catalog rows both want to update. Distinct from the migrator's key (7315200001).
 */
export const GRANTS_LOCK_KEY = 7_315_200_002;

/** Rounds of PBKDF2 in the verifier: PostgreSQL's default for `scram_iterations`. */
const SCRAM_ITERATIONS = 4096;
/** Random bytes of the salt: PostgreSQL's own length. */
const SCRAM_SALT_BYTES = 16;

/**
 * A grants step the configuration or the database refuses; the command prints the message and exits with code 1.
 *
 * Why: a role that is a superuser or owns tables, a name Postgres would fold, or a missing password must stop the deploy before the
 * application is started on it (decision 055).
 */
export class GrantsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantsRefusedError';
  }
}

/** What a password with a character outside printable ASCII is told; the value itself is never repeated. */
const PASSWORD_REFUSED =
  "The password of DATABASE_URL may use printable ASCII characters only (a generated hex or base64 value does): it becomes the role's SCRAM-SHA-256 verifier.";

/** The role and password the application connects with, read from `DATABASE_URL`. */
export interface ApplicationRole {
  readonly role: string;
  readonly password: string;
}

/**
 * What the grants step did: nothing (one role), or it created or updated the role and set its privileges.
 *
 * Why: the commands report it, so an operator sees which of the two happened.
 */
export type GrantsOutcome =
  | { readonly kind: 'same_role'; readonly role: string }
  | { readonly kind: 'granted'; readonly role: string; readonly created: boolean; readonly tables: number };

/**
 * Builds the SCRAM-SHA-256 verifier that Postgres stores for a password (`SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>`).
 *
 * Why: decision 055: the grants step sends the verifier, never the password, so a statement that fails cannot write the password into
 * the server's log, and the role signs in with the password as usual. Derived as PostgreSQL defines it (RFC 5802 and RFC 7677):
 * PBKDF2-HMAC-SHA-256 of the password with the salt and 4096 rounds gives the salted password; the stored key is the SHA-256 of
 * HMAC(salted password, "Client Key") and the server key is HMAC(salted password, "Server Key"); the salt, the stored key and the server
 * key are base64.
 *
 * @param password the role's password: printable ASCII (see {@link applicationRoleOf})
 * @param salt the salt; the system's random source gives 16 bytes unless a test fixes it
 * @returns the verifier text
 * @throws {GrantsRefusedError} for an empty password or one with a character outside printable ASCII
 */
export function scramSha256Verifier(password: string, salt: Uint8Array = randomBytes(SCRAM_SALT_BYTES)): string {
  if (!PASSWORD_CHARACTERS.test(password)) throw new GrantsRefusedError(PASSWORD_REFUSED);
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${Buffer.from(salt).toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Reads the application role from the two connection URLs.
 *
 * Why: decision 055: `DATABASE_URL` names the application's own role and `DATABASE_OWNER_URL` the owner of the tables; when they
 * name the same user (development, the tests) there is nothing to grant.
 *
 * @param appUrl `DATABASE_URL`: the application's connection string
 * @param ownerUrl the owner's connection string
 * @returns `{ sameRole }` when both URLs name one user, otherwise the application's role name and password (percent-decoded)
 * @throws {GrantsRefusedError} for a role name outside lower-case letters, digits and `_` (at most 63 characters), a missing
 *   password, a password with a character outside printable ASCII, or a URL that cannot be read
 */
export function applicationRoleOf(appUrl: string, ownerUrl: string): ApplicationRole | { readonly sameRole: string } {
  let role: string;
  let password: string;
  let owner: string;
  try {
    const app = new URL(appUrl);
    role = decodeURIComponent(app.username);
    password = decodeURIComponent(app.password);
    owner = decodeURIComponent(new URL(ownerUrl).username);
  } catch {
    throw new GrantsRefusedError('DATABASE_URL and DATABASE_OWNER_URL must be Postgres connection URLs.');
  }
  if (role === owner) return { sameRole: role };
  if (!ROLE_NAME.test(role)) {
    throw new GrantsRefusedError(
      'DATABASE_URL must name a role of lower-case letters, digits and "_" (at most 63 characters).',
    );
  }
  if (password === '') throw new GrantsRefusedError("DATABASE_URL must carry the application role's password.");
  if (!PASSWORD_CHARACTERS.test(password)) throw new GrantsRefusedError(PASSWORD_REFUSED);
  return { role, password };
}

/**
 * Creates or updates the application's role and sets exactly the privileges the code needs.
 *
 * Why: decision 055: the API and the worker connect as a role that is neither a superuser nor the owner of a table, so
 * a stolen login cannot change the schema, empty or rewrite the append-only tables, switch triggers off or run server programs. The
 * role may read and write every table, except that it may only read and insert the append-only tables; it has no `TRUNCATE`,
 * `REFERENCES` or `TRIGGER`, no right to create objects, and may use every sequence and read the migrations table (System health
 * counts the pending migrations). It runs after every migration, so new tables are covered.
 *
 * Side effects: in one transaction on the owner connection, under the transaction-level advisory lock {@link GRANTS_LOCK_KEY} (a
 * second run at the same time waits for the first instead of meeting it in the catalog), creates the role or sets its password and
 * attributes (no superuser, no createdb, no createrole, no replication, no bypassrls) and grants and revokes privileges in this
 * database. The password is never sent: the role gets the SCRAM-SHA-256 verifier computed here ({@link scramSha256Verifier}), so a
 * statement that fails cannot write the password into the server's log. Every statement with a role or table name is formatted by
 * Postgres itself (`format` with `%I` and `%L`), never joined in TypeScript.
 *
 * @param ownerUrl the owner's connection string (`DATABASE_OWNER_URL`)
 * @param appUrl the application's connection string (`DATABASE_URL`): its user and password are the role to set up
 * @returns `same_role` when both URLs name one user, otherwise what was done and how many tables the schema holds
 * @throws {GrantsRefusedError} when the role would be a superuser or owns a table, or the URLs are not usable (a password with a
 *   character outside printable ASCII included)
 * @throws {Error} when the owner cannot connect or a statement fails (the transaction is rolled back)
 */
export async function applyApplicationGrants(ownerUrl: string, appUrl: string): Promise<GrantsOutcome> {
  const target = applicationRoleOf(appUrl, ownerUrl);
  if ('sameRole' in target) return { kind: 'same_role', role: target.sameRole };
  const { role, password } = target;
  // Computed before anything is connected: the plain password never leaves this function.
  const verifier = scramSha256Verifier(password);

  const pool = new Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => undefined);
  try {
    const client = await pool.connect();
    client.on('error', () => undefined);
    try {
      /** Builds one statement with Postgres's own quoting and runs it. */
      const run = async (template: string, ...values: readonly string[]): Promise<void> => {
        const marks = values.map((_, index) => `$${index + 2}::text`).join(', ');
        const built = await client.query<{ statement: string }>(
          `select format($1::text${marks === '' ? '' : `, ${marks}`}) as statement`,
          [template, ...values],
        );
        await client.query(built.rows[0]?.statement ?? '');
      };

      await client.query('begin');
      // Taken first: what follows reads the role's state and then creates or alters it, so two runs must not interleave.
      await client.query('select pg_advisory_xact_lock($1)', [GRANTS_LOCK_KEY]);
      const existing = await client.query<{ superuser: boolean; owns: boolean }>(
        `select r.rolsuper as superuser,
                exists (select 1 from pg_tables t where t.schemaname = 'public' and t.tableowner = r.rolname) as owns
           from pg_roles r where r.rolname = $1`,
        [role],
      );
      const found = existing.rows[0];
      if (found?.superuser === true || found?.owns === true) {
        throw new GrantsRefusedError(
          `The role ${role} of DATABASE_URL is a superuser or owns tables: the application needs a role made for it alone (docs/OPERATIONS.md section 2).`,
        );
      }
      const attributes = 'nosuperuser nocreatedb nocreaterole noreplication nobypassrls';
      const created = found === undefined;
      await run(
        created
          ? `create role %I with login password %L ${attributes}`
          : `alter role %I with login password %L ${attributes}`,
        role,
        verifier,
      );
      const database = (await client.query<{ name: string }>('select current_database() as name')).rows[0]?.name ?? '';
      await run('grant connect on database %I to %I', database, role);
      await run('grant usage on schema public to %I', role);
      await run('grant select, insert, update, delete on all tables in schema public to %I', role);
      await run('revoke truncate, references, trigger on all tables in schema public from %I', role);
      for (const table of APPEND_ONLY_TABLES) {
        await run('revoke update, delete on table public.%I from %I', table, role);
      }
      await run('grant usage, select on all sequences in schema public to %I', role);
      const drizzle = await client.query<{ schema_present: boolean; table_present: boolean }>(
        `select to_regnamespace('drizzle') is not null as schema_present,
                to_regclass('drizzle.__drizzle_migrations') is not null as table_present`,
      );
      if (drizzle.rows[0]?.schema_present === true) await run('grant usage on schema drizzle to %I', role);
      if (drizzle.rows[0]?.table_present === true) {
        await run('grant select on drizzle.__drizzle_migrations to %I', role);
      }
      // The default of Postgres 15 and later; stated here so an older default cannot let the role create objects.
      await client.query('revoke create on schema public from public');
      const counted = await client.query<{ tables: number }>(
        "select count(*)::int as tables from pg_tables where schemaname = 'public'",
      );
      await client.query('commit');
      return { kind: 'granted', role, created, tables: counted.rows[0]?.tables ?? 0 };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
