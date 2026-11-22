// Public API of the database infrastructure (decisions 005, 027, 055): the Nest module and service, the transaction helper,
// the typed client builders, the migrator, the application role's grants step and the boot check of that role. Module schemas import ./columns directly, never this barrel.
export { DbModule } from './db.module';
export { DbService } from './db.service';
export { PostgresHealthIndicator } from './postgres.health';
export { createDrizzle, createPool } from './database';
export type { Database, DbExecutor, Schema, SessionTimeouts, Transaction } from './database';
export { PgListener } from './pg-listener';
export type { ListenClient, PgListenerOptions } from './pg-listener';
export { isForeignKeyViolation, isUniqueViolation, pgErrorInfo } from './pg-errors';
export type { PgErrorInfo } from './pg-errors';
export { escapeLike, listOrderBy, listWhere } from './list-sql';
export type { ListColumn, ListColumns } from './list-sql';
export { REPORT_STATEMENT_TIMEOUT_MS, onCommit, runInTransaction, runOrDiscard } from './transaction';
export type { IsolationLevel, TransactionContext, TransactionOptions, TransactionRunner } from './transaction';
export { MIGRATIONS_FOLDER, migrateDatabase } from './migrate';
export {
  APPEND_ONLY_TABLES,
  GRANTS_LOCK_KEY,
  GrantsRefusedError,
  applicationRoleOf,
  applyApplicationGrants,
  scramSha256Verifier,
} from './grants';
export type { ApplicationRole, GrantsOutcome } from './grants';
export {
  DATABASE_ROLE_FIX,
  DATABASE_ROLE_REASONS,
  DatabaseRoleCheck,
  databaseRoleRefusal,
  readDatabaseRole,
} from './database-role-check';
export type { DatabaseRoleFacts } from './database-role-check';
export { DatabaseRoleCheckModule } from './database-role-check.module';
export { databaseUrlFor, ownerUrlFor } from './url';
export * as schema from './schema';
