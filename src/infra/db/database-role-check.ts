// The boot check of the application's database role (decision 055): in production the API and the worker refuse to start when they
// connect as a superuser, an owner of a table or of the database, or a role that reaches the server's files or programs, or as a member of
// such a role. Provided by DatabaseRoleCheckModule, imported by both root modules.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { safeErrorText } from '../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DbService } from './db.service';

/**
 * What the connected role can be or become: a superuser, an owner of a table, a role that reaches the server's files or programs,
 * or the owner of the database. Each fact counts a membership of any kind (inherited or not): a member can switch to the role.
 */
export interface DatabaseRoleFacts {
  /** The role is a superuser or a member of a superuser role. */
  readonly superuser: boolean;
  /** The role owns a table of schema `public` or is a member of the role that owns one. */
  readonly ownsTables: boolean;
  /** The role is a member of `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`. */
  readonly serverAccess: boolean;
  /** The role owns the database it is connected to or is a member of its owner. */
  readonly ownsDatabase: boolean;
}

/**
 * Reads the privileges of the role a pool connects as.
 *
 * Why: decision 055: the application role must not own the tables (it could empty or rewrite them, or switch triggers off), must not
 * be a superuser, must not read or write files or run programs on the database server, and must not own the database. A role that is
 * only a member of such a role can switch to it (`SET ROLE`) even when it inherits nothing, so `pg_has_role(..., 'MEMBER')` is asked, not
 * only `'USAGE'` (membership with inheritance).
 *
 * @param pool anything with `query`: the application's pool
 * @returns the four facts of {@link DatabaseRoleFacts} for the current role
 */
export async function readDatabaseRole(pool: Pick<Pool, 'query'>): Promise<DatabaseRoleFacts> {
  const { rows } = await pool.query<{
    superuser: boolean;
    owns_tables: boolean;
    server_access: boolean;
    owns_database: boolean;
  }>(
    `select exists (select 1 from pg_roles s where s.rolsuper and pg_has_role(current_user, s.oid, 'MEMBER')) as superuser,
            exists (select 1 from pg_tables t where t.schemaname = 'public' and pg_has_role(current_user, t.tableowner, 'MEMBER')) as owns_tables,
            exists (select 1 from pg_roles p where p.rolname in ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
                      and pg_has_role(current_user, p.oid, 'MEMBER')) as server_access,
            exists (select 1 from pg_database d where d.datname = current_database() and pg_has_role(current_user, d.datdba, 'MEMBER')) as owns_database`,
  );
  const row = rows[0];
  return {
    superuser: row?.superuser === true,
    ownsTables: row?.owns_tables === true,
    serverAccess: row?.server_access === true,
    ownsDatabase: row?.owns_database === true,
  };
}

/**
 * What each refused fact means, in words that name the setting to fix and no value.
 *
 * Why: decision 055: the operator must learn which rule the role broke; a role name or an address never appears.
 */
export const DATABASE_ROLE_REASONS = {
  superuser: 'a superuser, or a member of a superuser role',
  serverAccess:
    'a member of pg_execute_server_program, pg_read_server_files or pg_write_server_files, which read and write files or run programs on the database server',
  ownsTables: 'an owner of a table, or a member of the role that owns one',
  ownsDatabase: 'the owner of the database, or a member of its owner',
} as const;

/** What to do about a refused role; the thrown error starts with the variable's name. */
export const DATABASE_ROLE_FIX =
  'in production the API and the worker connect as the application role that db:migrate creates (docs/OPERATIONS.md section 2)';

/**
 * Judges the facts of a role and words the refusal.
 *
 * Why: decision 055: one pure rule, tested for each fact without a database. A superuser is a member of every role, so its other
 * facts are implied and only the first reason is given.
 *
 * @param facts what {@link readDatabaseRole} found
 * @returns `undefined` for a role that may run the application; otherwise the message of the error (it starts with `DATABASE_URL`
 *   and names the broken rules, never a role name or a value)
 */
export function databaseRoleRefusal(facts: DatabaseRoleFacts): string | undefined {
  const reasons: string[] = [];
  if (facts.superuser) reasons.push(DATABASE_ROLE_REASONS.superuser);
  else {
    if (facts.serverAccess) reasons.push(DATABASE_ROLE_REASONS.serverAccess);
    if (facts.ownsTables) reasons.push(DATABASE_ROLE_REASONS.ownsTables);
    if (facts.ownsDatabase) reasons.push(DATABASE_ROLE_REASONS.ownsDatabase);
  }
  if (reasons.length === 0) return undefined;
  return `DATABASE_URL connects as ${reasons.join('; and as ')}: ${DATABASE_ROLE_FIX}`;
}

/**
 * Stops a production process that connects with too much power.
 *
 * Why: decision 055: a stolen application login must not be able to change the schema, empty the ledger or run server
 * programs, so the API and the worker run as a role that is neither a superuser, nor an owner of a table or of the database, nor a
 * member (of any kind) of such a role or of the server file and program roles. The check runs in
 * `onModuleInit`, before the process serves a request or runs a job. Outside production it does not even ask (the development and test
 * databases are used as their owner on purpose). A production process never runs with an unchecked role, like the check of
 * `LOOKUP_HASH_KEY` (decision 054): when the database does not answer the start stops, and the next start checks again.
 *
 * Side effects: one read of `pg_roles`, `pg_tables` and `pg_database` at start (production only).
 */
@Injectable()
export class DatabaseRoleCheck implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Runs the check at start.
   *
   * @throws {Error} as {@link DatabaseRoleCheck.verify}
   */
  async onModuleInit(): Promise<void> {
    await this.verify();
  }

  /**
   * Checks the role once.
   *
   * @returns `skipped` outside production (no query), `ok` when the role breaks none of the rules of {@link databaseRoleRefusal}
   * @throws {Error} in production, when the role breaks one of them (the message names `DATABASE_URL` and the rules, never a role
   *   name), or when the check could not be made (the message names `DATABASE_URL` and the sanitised failure, never a statement or a value)
   */
  async verify(): Promise<'ok' | 'skipped'> {
    if (!this.config.isProduction) return 'skipped';
    let facts: DatabaseRoleFacts;
    try {
      facts = await readDatabaseRole(this.db.pool);
    } catch (error) {
      return this.unchecked(error);
    }
    const refusal = databaseRoleRefusal(facts);
    if (refusal !== undefined) throw new Error(refusal);
    return 'ok';
  }

  /**
   * Stops a production start whose check could not be made.
   *
   * The thrown error has no `cause`: the driver's message of the failure can be the statement with its values (decision 054); the
   * sanitised text stands in for it.
   */
  private unchecked(error: unknown): never {
    throw new Error(
      `DATABASE_URL could not be checked: ${safeErrorText(error)}. A production process does not start with an unchecked database role; its next start checks again.`,
    );
  }
}
