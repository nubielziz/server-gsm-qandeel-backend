// Drizzle queries on payment_gateways (map routes /admin/payment-gateways, /client/payment-methods, stage 8): list with sort,
// search and exact count, find, insert, update, delete, the usage checks that guard a delete, and the 30-day volume of top-ups.
// Only the money module touches this table.
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor } from '../../../infra/db';
import { listOrderBy, listWhere } from '../../../infra/db/list-sql';
import { type NewPaymentGateway, type PaymentGateway, invoices, paymentGateways, payments } from '../db/schema';

/** The sort fields of the gateway list. */
export type GatewaySortField = 'name' | 'code' | 'audience' | 'createdAt';

const COLUMNS = {
  name: paymentGateways.name,
  code: paymentGateways.code,
  driver: paymentGateways.driver,
  audience: paymentGateways.audience,
  isActive: paymentGateways.isActive,
  createdAt: paymentGateways.createdAt,
};

/**
 * Lists gateways.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches name, code and driver)
 * @returns the page of rows and the number matching the filters
 */
export async function listGatewayRows(
  db: DbExecutor,
  query: ParsedListQuery<GatewaySortField>,
): Promise<{ rows: PaymentGateway[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(paymentGateways)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, paymentGateways.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(paymentGateways)
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Finds a gateway by id.
 *
 * @param db the database or a transaction
 * @param id the gateway id
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the row, or `undefined`
 */
export async function findGateway(db: DbExecutor, id: number, lock = false): Promise<PaymentGateway | undefined> {
  const query = db.select().from(paymentGateways).where(eq(paymentGateways.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds a gateway by its code (the segment of `/webhooks/payments/:gateway`).
 *
 * @param db the database or a transaction
 * @param code the lower-case code
 * @returns the row, or `undefined`
 */
export async function findGatewayByCode(db: DbExecutor, code: string): Promise<PaymentGateway | undefined> {
  const [row] = await db.select().from(paymentGateways).where(eq(paymentGateways.code, code)).limit(1);
  return row;
}

/**
 * Finds several gateways at once.
 *
 * @param db the database or a transaction
 * @param ids the gateway ids
 * @returns the rows by id
 */
export async function findGatewaysByIds(db: DbExecutor, ids: readonly number[]): Promise<Map<number, PaymentGateway>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(paymentGateways).where(inArray(paymentGateways.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Lists the active gateways a B2B merchant of a group may top up through.
 *
 * Why: B162: active, audience b2b or both, and the gateway lists no groups or lists the merchant's group, ordered by name.
 *
 * @param db the database or a transaction
 * @param groupId the merchant's group
 * @returns the gateways
 */
export async function listGatewaysForGroup(db: DbExecutor, groupId: number): Promise<PaymentGateway[]> {
  return db
    .select()
    .from(paymentGateways)
    .where(
      and(
        eq(paymentGateways.isActive, true),
        inArray(paymentGateways.audience, ['b2b', 'both']),
        or(
          sql`cardinality(${paymentGateways.allowedGroupIds}) = 0`,
          sql`${groupId} = any(${paymentGateways.allowedGroupIds})`,
        ),
      ),
    )
    .orderBy(paymentGateways.name, paymentGateways.id);
}

/**
 * Inserts a gateway.
 *
 * Side effects: inserts a `payment_gateways` row.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row
 */
export async function insertGateway(db: DbExecutor, row: NewPaymentGateway): Promise<PaymentGateway> {
  const [created] = await db.insert(paymentGateways).values(row).returning();
  return created!;
}

/**
 * Updates a gateway.
 *
 * Side effects: updates the `payment_gateways` row.
 *
 * @param db the caller's transaction
 * @param id the gateway id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateGateway(
  db: DbExecutor,
  id: number,
  changes: Partial<NewPaymentGateway>,
): Promise<PaymentGateway> {
  const [updated] = await db.update(paymentGateways).set(changes).where(eq(paymentGateways.id, id)).returning();
  return updated!;
}

/**
 * Deletes a gateway.
 *
 * Side effects: deletes the `payment_gateways` row.
 *
 * @param db the caller's transaction
 * @param id the gateway id
 */
export async function deleteGateway(db: DbExecutor, id: number): Promise<void> {
  await db.delete(paymentGateways).where(eq(paymentGateways.id, id));
}

/**
 * Tells whether any payment or invoice points at a gateway.
 *
 * Why: B70: a gateway with payments cannot be deleted (the foreign key would refuse anyway); an invoice that chose it counts too.
 *
 * @param db the database or a transaction
 * @param id the gateway id
 * @returns true when a payment or an invoice references it
 */
export async function gatewayIsUsed(db: DbExecutor, id: number): Promise<boolean> {
  const [payment] = await db.select({ id: payments.id }).from(payments).where(eq(payments.gatewayId, id)).limit(1);
  if (payment) return true;
  const [invoice] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.gatewayId, id)).limit(1);
  return invoice !== undefined;
}

/**
 * The money taken through each gateway in a window, from top-up payments (base currency).
 *
 * Why: RESOLUTIONS money-5: `volume30d` is the sum of `payments.amount` captured in the window, any status except pending,
 * failed and rejected. Top-ups are issued in the base currency; storefront payments are added by the caller from their
 * converted amounts.
 *
 * @param db the database or a transaction
 * @param ids the gateways
 * @param since the start of the window (`captured_at >=`, the clock's time minus 30 days)
 * @returns the sum per gateway; a gateway with no payments has no entry
 */
export async function topupVolumes(db: DbExecutor, ids: readonly number[], since: Date): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ gatewayId: payments.gatewayId, total: sql<string>`sum(${payments.amount})::text` })
    .from(payments)
    .where(
      and(
        eq(payments.purpose, 'topup'),
        inArray(payments.gatewayId, [...ids]),
        sql`${payments.capturedAt} >= ${since}`,
        notInArray(payments.status, ['pending', 'failed', 'rejected']),
      ),
    )
    .groupBy(payments.gatewayId);
  return new Map(rows.map((row) => [row.gatewayId, row.total]));
}

/** What taking a deleted group out of the gateways did. */
export interface DroppedGroup {
  /** How many gateways listed the group. */
  readonly changed: number;
  /** The gateways only that group could use: now turned off, since an empty list would open them to every group. */
  readonly turnedOffIds: readonly number[];
}

/**
 * Takes a deleted merchant group out of every gateway that listed it.
 *
 * Why: catalog-5: a deleted group's id must not stay in `payment_gateways.allowed_group_ids`. An empty list means "every group",
 * so a gateway that only the deleted group could use would quietly open to all merchants: it is turned off in the same
 * statement instead, and staff choose its groups again before turning it back on.
 *
 * @param db the transaction of the group delete
 * @param groupId the deleted group
 * @returns how many gateways changed and which were turned off
 */
export async function dropGroupFromGateways(db: DbExecutor, groupId: number): Promise<DroppedGroup> {
  const remaining = sql`array_remove(${paymentGateways.allowedGroupIds}, ${groupId})`;
  const rows = await db
    .update(paymentGateways)
    .set({
      allowedGroupIds: remaining,
      isActive: sql`case when cardinality(${remaining}) = 0 then false else ${paymentGateways.isActive} end`,
    })
    .where(sql`${groupId} = any(${paymentGateways.allowedGroupIds})`)
    .returning({ id: paymentGateways.id, allowedGroupIds: paymentGateways.allowedGroupIds });
  return {
    changed: rows.length,
    turnedOffIds: rows.filter((row) => row.allowedGroupIds.length === 0).map((row) => row.id),
  };
}
