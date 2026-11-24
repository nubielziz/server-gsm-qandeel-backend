// Helpers for the funnel tests (feature 19): checkout sessions with their guest straight into the test database (a guest is a retail row
// of the account table without a login).
import { type Database, schema as s } from '@src/infra/db';
import { EncryptionService } from '@src/infra/crypto';
import { CHECKOUT_IMEI_AAD } from '@src/modules/customers';
import { makeAccount } from './accounts';
import type { TestApp } from './app';

/** What {@link insertCheckout} can vary. */
export interface CheckoutSpec {
  readonly serviceId: number;
  readonly createdAt: Date;
  readonly email?: string;
  readonly name?: string;
  readonly customerStatus?: 'active' | 'suspended' | 'blocked';
  readonly orderId?: number | null;
  readonly status?: 'open' | 'paid' | 'expired';
  readonly gross?: string;
  readonly currency?: string;
  readonly fxRate?: string;
  readonly utm?: Record<string, unknown>;
  /** A plain IMEI to store encrypted on the session. */
  readonly imei?: string;
  /** Leave the session without an account. */
  readonly noCustomer?: boolean;
}

/** What {@link insertCheckout} made. */
export interface InsertedCheckout {
  readonly sessionId: number;
  /** The guest's account id, or `null` for a session without one. */
  readonly accountId: number | null;
  /** The same as `accountId`, under the name the old helper used. */
  readonly customerId: number | null;
  readonly token: string;
  readonly email: string;
}

let counter = 0;

/**
 * Inserts a checkout session with its guest account (a retail row without a login).
 *
 * @param t the running test app (for the encryption of the IMEI)
 * @param db the test database
 * @param spec what the checkout looks like
 * @returns the ids and the token
 */
export async function insertCheckout(t: TestApp, db: Database, spec: CheckoutSpec): Promise<InsertedCheckout> {
  counter += 1;
  const email = spec.email ?? `buyer${counter}@mail.example`;
  let accountId: number | null = null;
  if (!spec.noCustomer) {
    const guest = await makeAccount({
      db,
      rank: 'retail',
      guest: true,
      email,
      name: spec.name ?? '',
      country: '',
      status: spec.customerStatus ?? 'active',
      createdAt: spec.createdAt,
      updatedAt: spec.createdAt,
    });
    accountId = guest.id;
  }
  const token = `tok${counter}${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const [session] = await db
    .insert(s.checkoutSessions)
    .values({
      token,
      accountId,
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
      createdAt: spec.createdAt,
      updatedAt: spec.createdAt,
    })
    .returning({ id: s.checkoutSessions.id });
  return { sessionId: session!.id, accountId, customerId: accountId, token, email };
}
