// Helpers for the growth tests (feature 19): the recovery email template, abandoned checkouts with their customer and consent straight into
// the test database, the job a `checkout.recovery` event becomes, and the data of the funnel.
import { and, eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { EncryptionService } from '../../src/infra/crypto';
import { CHECKOUT_IMEI_AAD } from '../../src/modules/customers';
import type { RecoveryMailResult } from '../../src/modules/customers/application/recovery-mail';
import { CHECKOUT_RECOVERY_EVENT } from '../../src/modules/customers/application/recovery-outbox';
import { CheckoutRecoveryProcessor } from '../../src/modules/customers/jobs/checkout-recovery.processors';
import type { OutboxJobData } from '../../src/modules/platform';
import type { TestApp } from './app';

/** The words of the recovery template the tests install: the three placeholders of the event. */
export const RECOVERY_TEMPLATE = {
  subject: 'You left something behind',
  body: 'Hi {{customerName}}, you started an unlock for {{device}} and did not finish paying. Pick up where you left off: {{link}}',
} as const;

/**
 * Installs the active `checkout.abandoned` email template of customers (the seed's; the migration ships none).
 *
 * @param db the test database
 * @param values changes, such as `{ isActive: false }`
 */
export async function insertRecoveryTemplate(
  db: Database,
  values: Partial<typeof s.notificationTemplates.$inferInsert> = {},
): Promise<void> {
  await db.insert(s.notificationTemplates).values({
    event: 'checkout.abandoned',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    ...RECOVERY_TEMPLATE,
    isActive: true,
    ...values,
  });
}

/** What {@link insertAbandoned} can vary. */
export interface AbandonedSpec {
  readonly serviceId: number;
  readonly createdAt: Date;
  readonly email?: string;
  readonly name?: string;
  /** The customer's marketing answer: a granted record (default), a withdrawn one (a grant, then a refusal), or no record at all. */
  readonly consent?: 'granted' | 'withdrawn' | 'none';
  /** The customer's own switch (`marketing_opt_in`), default `true` when consent is granted. */
  readonly optIn?: boolean;
  readonly customerStatus?: 'active' | 'suspended' | 'blocked';
  readonly locale?: string;
  readonly recoveryEmailedAt?: Date | null;
  readonly orderId?: number | null;
  readonly status?: 'open' | 'paid' | 'expired';
  readonly gross?: string;
  readonly currency?: string;
  readonly fxRate?: string;
  readonly utm?: Record<string, unknown>;
  /** A plain IMEI to store encrypted on the session (the job reads the TAC from it). */
  readonly imei?: string;
  /** Leave the session without a customer. */
  readonly noCustomer?: boolean;
}

/** What {@link insertAbandoned} made. */
export interface Abandoned {
  readonly sessionId: number;
  readonly customerId: number | null;
  readonly token: string;
  readonly email: string;
}

let counter = 0;

/**
 * Inserts a checkout session with its guest customer and marketing consent.
 *
 * @param t the running test app (for the encryption of the IMEI)
 * @param db the test database
 * @param spec what the checkout looks like
 * @returns the ids and the token
 */
export async function insertAbandoned(t: TestApp, db: Database, spec: AbandonedSpec): Promise<Abandoned> {
  counter += 1;
  const email = spec.email ?? `buyer${counter}@mail.example`;
  const consent = spec.consent ?? 'granted';
  let customerId: number | null = null;
  if (!spec.noCustomer) {
    const [customer] = await db
      .insert(s.customers)
      .values({
        email,
        name: spec.name ?? '',
        locale: spec.locale ?? 'en',
        marketingOptIn: spec.optIn ?? consent === 'granted',
        status: spec.customerStatus ?? 'active',
        createdAt: spec.createdAt,
        updatedAt: spec.createdAt,
      })
      .returning({ id: s.customers.id });
    customerId = customer!.id;
  }
  const token = `tok${counter}${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const [session] = await db
    .insert(s.checkoutSessions)
    .values({
      token,
      customerId,
      email,
      serviceId: spec.serviceId,
      imeiEnc: spec.imei === undefined ? null : t.app.get(EncryptionService).encrypt(spec.imei, CHECKOUT_IMEI_AAD),
      currency: spec.currency ?? 'USD',
      fxRate: spec.fxRate ?? '1',
      netAmount: spec.gross ?? '4.7900',
      grossAmount: spec.gross ?? '4.7900',
      utm: spec.utm ?? { source: 'Direct' },
      status: spec.status ?? 'open',
      expiresAt: new Date(spec.createdAt.getTime() + 30 * 60_000),
      orderId: spec.orderId ?? null,
      recoveryEmailedAt: spec.recoveryEmailedAt ?? null,
      createdAt: spec.createdAt,
      updatedAt: spec.createdAt,
    })
    .returning({ id: s.checkoutSessions.id });
  if (customerId !== null && consent !== 'none') {
    const record = (granted: boolean, at: Date) => ({
      subjectType: 'customer' as const,
      subjectId: customerId,
      purpose: 'marketing' as const,
      granted,
      checkoutSessionId: session!.id,
      ip: '203.0.113.7',
      createdAt: at,
    });
    await db
      .insert(s.consentRecords)
      .values(
        consent === 'granted'
          ? [record(true, spec.createdAt)]
          : [record(true, spec.createdAt), record(false, new Date(spec.createdAt.getTime() + 1_000))],
      );
  }
  return { sessionId: session!.id, customerId, token, email };
}

/**
 * Reads the `checkout.recovery` events written so far, as the jobs the relay would add.
 *
 * @param db the test database
 * @returns one job data per event, by event id
 */
export async function recoveryJobs(db: Database): Promise<OutboxJobData[]> {
  const rows = await db
    .select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, CHECKOUT_RECOVERY_EVENT))
    .orderBy(s.outboxEvents.id);
  return rows.map((row) => ({
    eventId: row.id,
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: {},
    requestId: `test-${row.id}`,
  }));
}

/**
 * Runs the mail job of one event, as the worker would.
 *
 * @param t the running test app
 * @param job the event's job data
 * @param attemptsMade how many attempts the queue made before this one
 * @returns what the job answered; a transient failure rejects
 */
export function runRecoveryMail(t: TestApp, job: OutboxJobData, attemptsMade = 0): Promise<RecoveryMailResult> {
  return t.app.get(CheckoutRecoveryProcessor).process({ data: job, attemptsMade, opts: { attempts: 5 } } as never);
}

/**
 * Reads the outbox events of recovery emails of one checkout.
 *
 * @param db the test database
 * @param sessionId the checkout
 * @returns how many events were written
 */
export async function recoveryEventCount(db: Database, sessionId: number): Promise<number> {
  const rows = await db
    .select({ id: s.outboxEvents.id })
    .from(s.outboxEvents)
    .where(and(eq(s.outboxEvents.type, CHECKOUT_RECOVERY_EVENT), eq(s.outboxEvents.aggregateId, sessionId)));
  return rows.length;
}
