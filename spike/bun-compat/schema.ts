// Bun compatibility spike: a tiny Drizzle schema in its own Postgres schema ("spike") so cleanup is one DROP.
import { numeric, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const spike = pgSchema('spike');

/** A balance row, used to prove numeric-as-string and SELECT ... FOR UPDATE inside a transaction. */
export const spikeAccounts = spike.table('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  balance: numeric('balance', { precision: 18, scale: 4 }).notNull().default('0'),
});

/** One row per processed job; the unique job_id proves idempotent processing. */
export const spikeJobs = spike.table('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: text('job_id').notNull().unique(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
});
