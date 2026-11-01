// Drizzle queries on outbox_events, the transactional outbox (platform module, decision 020).
import { and, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type OutboxEvent, outboxEvents } from '../db/schema';
import type { OutboxBacklog } from './outbox.types';

/** The Postgres channel the relay listens on. */
export const OUTBOX_CHANNEL = 'outbox';

/** A pending row that failed to relay waits `2^attempts` seconds (at most five minutes) before the relay tries it again. */
const RETRY_BASE_SECONDS = 1;
const RETRY_MAX_SECONDS = 300;
const RETRY_MAX_EXPONENT = 9;

/** A pending row as the relay reads it: the row plus how long it has waited, by the injected clock (decision 031). */
export type PendingOutboxEvent = OutboxEvent & { readonly lagSeconds: number };

/**
 * Writes an outbox row and announces it.
 *
 * Why: the row and the NOTIFY belong to the caller's transaction, so a rolled-back change leaves neither (Postgres
 * delivers a NOTIFY only when its transaction commits).
 *
 * @param tx the caller's transaction
 * @param values the row to insert (the payload already carries `meta.requestId`)
 * @param now the creation time, from the injected clock (decision 031): the lag and the retry wait are measured from it
 * @returns the inserted row
 */
export async function insertOutboxEvent(
  tx: DbExecutor,
  values: { type: string; aggregateType: string; aggregateId: number; payload: Record<string, unknown> },
  now: Date,
): Promise<OutboxEvent> {
  const [row] = await tx
    .insert(outboxEvents)
    .values({ ...values, createdAt: now, updatedAt: now })
    .returning();
  if (!row) throw new Error('Inserting an outbox row returned no row.');
  await tx.execute(sql`select pg_notify(${OUTBOX_CHANNEL}, ${String(row.id)})`);
  return row;
}

/**
 * Locks the next pending rows for this relay pass.
 *
 * Why: decision 020: `ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED` lets several relays (two workers, a tick and a NOTIFY
 * wake-up) share the backlog without ever taking the same row. Rows that failed before are held back with an exponential
 * wait so that one bad row cannot keep the relay busy.
 *
 * @param tx the relay's transaction
 * @param limit the batch size
 * @param now the current time, from the injected clock (decision 031)
 * @returns up to `limit` pending rows, oldest first, locked until the transaction ends
 */
export async function lockPendingOutboxEvents(tx: DbExecutor, limit: number, now: Date): Promise<PendingOutboxEvent[]> {
  const retryWait = sql`interval '1 second' * least(${RETRY_BASE_SECONDS} * power(2, least(${outboxEvents.attempts}, ${RETRY_MAX_EXPONENT})), ${RETRY_MAX_SECONDS})`;
  return tx
    .select({
      ...getTableColumns(outboxEvents),
      lagSeconds: sql<number>`extract(epoch from (${now}::timestamptz - ${outboxEvents.createdAt}))::float8`,
    })
    .from(outboxEvents)
    .where(
      and(
        isNull(outboxEvents.processedAt),
        sql`(${outboxEvents.attempts} = 0 or ${outboxEvents.updatedAt} <= ${now}::timestamptz - ${retryWait})`,
      ),
    )
    .orderBy(outboxEvents.id)
    .limit(limit)
    .for('update', { skipLocked: true });
}

/**
 * Marks rows as handed to their queues.
 *
 * @param tx the relay's transaction
 * @param ids the rows whose jobs were added
 * @param now the relay time, from the injected clock (decision 031)
 */
export async function markOutboxRelayed(tx: DbExecutor, ids: readonly number[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(outboxEvents)
    .set({ processedAt: now, attempts: sql`${outboxEvents.attempts} + 1`, updatedAt: now })
    .where(inArray(outboxEvents.id, [...ids]));
}

/**
 * Counts a failed attempt on rows that could not be handed over.
 *
 * @param tx the relay's transaction
 * @param ids the rows that failed
 * @param now the time of the failed attempt, from the injected clock (decision 031)
 */
export async function markOutboxFailed(tx: DbExecutor, ids: readonly number[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  // updated_at is set from the same clock that lockPendingOutboxEvents compares it with, so the retry wait is exact.
  await tx
    .update(outboxEvents)
    .set({ attempts: sql`${outboxEvents.attempts} + 1`, updatedAt: now })
    .where(inArray(outboxEvents.id, [...ids]));
}

/**
 * Reads the size of the backlog.
 *
 * @param db the database or a transaction
 * @param now the current time, from the injected clock (decision 031)
 * @returns how many rows wait and how long the oldest has waited
 */
export async function outboxBacklog(db: DbExecutor, now: Date): Promise<OutboxBacklog> {
  const { rows } = await db.execute<{ pending: number; oldest_age: number | null }>(
    sql`select count(*)::int as pending, extract(epoch from (${now}::timestamptz - min(created_at)))::float8 as oldest_age from outbox_events where processed_at is null`,
  );
  const row = rows[0];
  return { pending: row?.pending ?? 0, oldestAgeSeconds: Math.max(0, row?.oldest_age ?? 0) };
}
