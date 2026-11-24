// Helpers for the risk and privacy tests (feature 18): a held storefront order with its checkout session, payment, ledger posting and
// assessment, direct inserts of blocklist entries and data requests, and the audit rows of an order. The buyer is an account of the
// retail rank (a guest row unless a test asks for a login); every table names it in `account_id`.
import { and, asc, desc, eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { b2cPay, postTransaction } from '@src/modules/money';
import { blockHashInput } from '@src/modules/risk';
import type { TestApp } from './app';
import { makeAccount } from './accounts';
import { insertOrderRow, type OrdersWorld } from './orders';

/** A held order and everything around it. */
export interface HeldOrder {
  readonly orderId: number;
  /** The buyer's account id. */
  readonly accountId: number;
  /** The same number as `accountId`, under the name the old helper used. */
  readonly customerId: number;
  readonly assessmentId: number;
  readonly sessionId: number;
  readonly paymentId: number;
  readonly imei: string;
}

/** What a test can change about the held order. */
export interface HeldOptions {
  readonly serviceId?: number;
  /** Columns of the buyer's account row (a guest of the retail rank unless these say otherwise). */
  readonly customer?: Partial<typeof s.clients.$inferInsert>;
  /** Buy as this existing account instead of inserting a new one. */
  readonly customerId?: number;
  readonly imei?: string;
  readonly signals?: string[];
  readonly score?: number;
  readonly net?: string;
  readonly vat?: string;
  readonly dispatchState?: 'held' | 'pending';
  readonly createdAt?: Date;
  readonly methodType?: 'card' | 'wallet' | 'crypto';
  readonly cardFingerprint?: string;
  /** The checkout session's encrypted IMEI (`checkout_sessions.imei_enc`). */
  readonly sessionImeiEnc?: string;
  /** Whether a signed-in account opened the checkout (`checkout_sessions.opened_signed_in`); default `false`, as the column. */
  readonly openedSignedIn?: boolean;
}

/**
 * Inserts a paid storefront order that the rules hold: the buyer's account, the checkout session (USD), the order (`pending`, dispatch
 * state `held`), the captured payment, the `b2c_pay` ledger posting (so a refund has money to return) and the `review` assessment.
 *
 * @param world the orders world (its automatic service is the default)
 * @param options what to change
 * @returns the ids
 */
export async function insertHeldOrder(world: OrdersWorld, options: HeldOptions = {}): Promise<HeldOrder> {
  const { db } = world;
  const imei = options.imei ?? '353890113898412';
  const net = options.net ?? '12.4900';
  const vat = options.vat ?? '2.5000';
  const [customer] =
    options.customerId === undefined
      ? [
          (
            await makeAccount({
              db,
              rank: 'retail',
              guest: true,
              email: `buyer-${crypto.randomUUID()}@example.com`,
              name: 'Jack Turner',
              country: 'GB',
              ...options.customer,
            })
          ).row,
        ]
      : await db.select().from(s.clients).where(eq(s.clients.id, options.customerId));
  const [session] = await db
    .insert(s.checkoutSessions)
    .values({
      token: crypto.randomUUID(),
      accountId: customer!.id,
      email: customer!.email,
      serviceId: options.serviceId ?? world.auto.serviceId,
      currency: 'USD',
      netAmount: net,
      taxAmount: vat,
      grossAmount: Money.of(net).add(Money.of(vat)).toWire(),
      taxCountry: 'GB',
      ip: '203.0.113.25',
      userAgent: 'Mozilla/5.0',
      imeiEnc: options.sessionImeiEnc ?? null,
      ...(options.openedSignedIn === undefined ? {} : { openedSignedIn: options.openedSignedIn }),
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    .returning();
  const order = await insertOrderRow(db, {
    accountId: customer!.id,
    serviceId: options.serviceId ?? world.auto.serviceId,
    source: 'store',
    status: 'pending',
    dispatchState: options.dispatchState ?? 'held',
    imei,
    unitPrice: net,
    totalPrice: net,
    taxAmount: vat,
    checkoutSessionId: session!.id,
    ...(options.createdAt ? { createdAt: options.createdAt, placedAt: options.createdAt } : {}),
  });
  await db
    .update(s.checkoutSessions)
    .set({ orderId: order.id, status: 'paid' })
    .where(eq(s.checkoutSessions.id, session!.id));
  const [gateway] = await db
    .insert(s.paymentGateways)
    .values({ code: `stripe-${crypto.randomUUID().slice(0, 6)}`, driver: 'stripe', name: 'Card' })
    .returning({ id: s.paymentGateways.id });
  const [payment] = await db
    .insert(s.payments)
    .values({
      accountId: customer!.id,
      orderId: order.id,
      purpose: 'order',
      gatewayId: gateway!.id,
      amount: Money.of(net).add(Money.of(vat)).toWire(),
      currency: 'USD',
      status: 'captured',
      methodType: options.methodType ?? 'card',
      cardFingerprint: options.cardFingerprint ?? null,
      capturedAt: options.createdAt ?? new Date(),
    })
    .returning({ id: s.payments.id });
  await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...b2cPay({ net: Money.of(net), vat: Money.of(vat) }),
        refId: order.id,
        idempotencyKey: `test:pay:${order.id}`,
        currency: 'USD',
        createdBy: { type: 'system', id: null },
      },
      new Date(),
    ),
  );
  const [assessment] = await db
    .insert(s.riskAssessments)
    .values({
      checkoutSessionId: session!.id,
      orderId: order.id,
      accountId: customer!.id,
      score: options.score ?? 62,
      decision: 'review',
      signals: options.signals ?? ['Disposable email domain', 'IP country differs from card country'],
    })
    .returning({ id: s.riskAssessments.id });
  return {
    orderId: order.id,
    accountId: customer!.id,
    customerId: customer!.id,
    assessmentId: assessment!.id,
    sessionId: session!.id,
    paymentId: payment!.id,
    imei,
  };
}

/** The newest assessment of an order. */
export async function assessmentOf(db: Database, orderId: number) {
  const [row] = await db
    .select()
    .from(s.riskAssessments)
    .where(eq(s.riskAssessments.orderId, orderId))
    .orderBy(desc(s.riskAssessments.id))
    .limit(1);
  return row!;
}

/** Every blocklist entry, oldest first. */
export async function blocklistRows(db: Database) {
  return db.select().from(s.blocklistEntries).orderBy(asc(s.blocklistEntries.id));
}

/** Inserts a blocklist entry the way the module would: the keyed hash of the normalised value. */
export async function insertBlock(
  t: TestApp,
  db: Database,
  kind: 'email' | 'domain' | 'imei' | 'card' | 'device' | 'country',
  value: string,
  values: Partial<typeof s.blocklistEntries.$inferInsert> = {},
) {
  const [row] = await db
    .insert(s.blocklistEntries)
    .values({
      kind,
      valueHash: t.app.get(TokenService).lookupHash(blockHashInput(kind, value)),
      display: value,
      reason: 'Test',
      ...values,
    })
    .returning();
  return row!;
}

/** The audit rows of an entity type and id, oldest first. */
export async function auditRows(db: Database, entityType: string, entityId?: number) {
  return db
    .select()
    .from(s.auditLogs)
    .where(
      entityId === undefined
        ? eq(s.auditLogs.entityType, entityType)
        : and(eq(s.auditLogs.entityType, entityType), eq(s.auditLogs.entityId, entityId)),
    )
    .orderBy(asc(s.auditLogs.id));
}
