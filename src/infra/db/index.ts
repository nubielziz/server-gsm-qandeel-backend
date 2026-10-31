// Public API of the database infrastructure (decisions 005, 027): the Nest module and service, the transaction helper,
// the typed client builders and the migrator. Module schemas import ./columns directly, never this barrel.
export { DbModule } from './db.module';
export { DbService } from './db.service';
export { PostgresHealthIndicator } from './postgres.health';
export { createDrizzle, createPool } from './database';
export type { Database, DbExecutor, Schema, Transaction } from './database';
export { runInTransaction } from './transaction';
export type { IsolationLevel, TransactionContext, TransactionOptions, TransactionRunner } from './transaction';
export { MIGRATIONS_FOLDER, migrateDatabase } from './migrate';
export { databaseUrlFor } from './url';
export * as schema from './schema';
