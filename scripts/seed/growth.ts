// Seeder of the growth pages (feature 19): the demo's 238 left checkouts (`S.checkouts`) as `checkout_sessions`, each with the guest
// customer of its email and the marketing answer the console mock makes up for it. The ids are the demo's (`CK-3001` is 3001). Runs after the
// money seed (currencies) and the catalog seed (services).
//
// Mapping, as the frontend mock maps it (src/features/checkouts/mocks/store.ts): the basket is in the buyer's currency, so the USD gross is
// `gross / rate` and the session keeps that currency's current rate (the console shows `grossAmount x fxRate`, the demo's amount again);
// `recovery` sent/converted becomes `recovery_emailed_at` one hour after the checkout (the demo's reminder delay); `converted` becomes status
// `paid` with no order, because the storefront orders arrive with feature 16's seed; the answer to marketing is agreed for about seven in ten
// (the mock's `agreedToMarketing`), and a few of the others have a withdrawn record. The funnel's IMEI checks are the risk module's seed.
//
// Ids of rows this seeder invents (the guest customers and the consent records) start at 900 000, so a seeder of the customers module that
// writes the demo's own customer ids never meets them whichever runs first.
import { randomBytes } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { CHECKOUT_SESSION_TTL_MINUTES } from '../../src/modules/customers';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

/** A checkout of the demo seed, as the demo stores it (the fields the seed uses). */
interface DemoCheckout {
  id: string;
  email: string;
  country: string;
  sid: string;
  gross: number;
  cur: string;
  created: number;
  recovery: 'none' | 'pending' | 'sent' | 'converted';
  status: 'open' | 'expired';
  src: string;
}

const MINUTE_MS = 60_000;
const FIRST_INVENTED_ID = 900_000;

/** Stable per checkout: the same people agree on every run (the mock's `agreedToMarketing`). */
export const agreedToMarketing = (id: number): boolean => (id * 7) % 10 < 7;

/** Of the buyers who did not agree, those who once agreed and then withdrew (every fifth): a refusal record, not a missing one. */
const withdrew = (id: number): boolean => !agreedToMarketing(id) && id % 5 === 0;

/**
 * Seeds the abandoned checkouts.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns the reports of `customers`, `checkout_sessions` and `consent_records`
 */
export async function seedGrowth(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const checkouts = demoRows<DemoCheckout>(demo, 'checkouts');
  if (checkouts.length === 0) return [];

  const rates = new Map(
    (await db.select({ code: s.currencies.code, rate: s.currencies.rateToBase }).from(s.currencies)).map((row) => [
      row.code,
      Number(row.rate),
    ]),
  );
  // A buyer who left several checkouts is one customer, and the newest checkout speaks for them (their switch and country).
  const newest = new Map<string, DemoCheckout>();
  const firstSeen = new Map<string, number>();
  for (const row of checkouts) {
    const key = row.email.toLowerCase();
    const seen = newest.get(key);
    if (!seen || row.created > seen.created) newest.set(key, row);
    firstSeen.set(key, Math.min(row.created, firstSeen.get(key) ?? row.created));
  }
  const emails = [...newest.keys()];

  // One guest customer per address; an address that already belongs to someone (the customers seed) keeps its customer.
  const customerReport = await insertRows(
    db,
    s.customers,
    emails.map((email, index) => {
      const row = newest.get(email)!;
      return {
        id: FIRST_INVENTED_ID + index,
        email,
        country: row.country,
        hasAccount: false,
        marketingOptIn: agreedToMarketing(demoNumericId(row.id)),
        createdAt: toDate(firstSeen.get(email))!,
        updatedAt: toDate(row.created)!,
      };
    }),
  );
  await syncIdentity(db, s.customers);
  const customerIds = new Map(
    (
      await db
        .select({ id: s.customers.id, email: sql<string>`lower(${s.customers.email})` })
        .from(s.customers)
        .where(inArray(sql`lower(${s.customers.email})`, emails))
    ).map((row) => [row.email, row.id]),
  );

  const sessions = checkouts.map((row) => {
    const id = demoNumericId(row.id);
    const rate = rates.get(row.cur) ?? 1;
    const created = toDate(row.created)!;
    const emailed = row.recovery === 'sent' || row.recovery === 'converted';
    return {
      id,
      token: randomBytes(16).toString('base64url'),
      customerId: customerIds.get(row.email.toLowerCase()) ?? null,
      email: row.email,
      serviceId: demoNumericId(row.sid),
      currency: row.cur,
      fxRate: rate.toFixed(8),
      netAmount: toMoney(row.gross / rate),
      grossAmount: toMoney(row.gross / rate),
      taxCountry: row.country,
      utm: { source: row.src },
      status: row.recovery === 'converted' ? ('paid' as const) : row.status,
      expiresAt: new Date(created.getTime() + CHECKOUT_SESSION_TTL_MINUTES * MINUTE_MS),
      recoveryEmailedAt: emailed ? new Date(created.getTime() + 60 * MINUTE_MS) : null,
      createdAt: created,
      updatedAt: created,
    };
  });
  const sessionReport = await insertRows(db, s.checkoutSessions, sessions);

  const consents = checkouts.flatMap((row) => {
    const id = demoNumericId(row.id);
    const customerId = customerIds.get(row.email.toLowerCase());
    if (customerId === undefined || (!agreedToMarketing(id) && !withdrew(id))) return [];
    const at = toDate(row.created)!;
    const record = (granted: boolean, when: Date, offset: number) => ({
      id: FIRST_INVENTED_ID + id * 2 + offset,
      subjectType: 'customer' as const,
      subjectId: customerId,
      purpose: 'marketing' as const,
      granted,
      checkoutSessionId: id,
      ip: '203.0.113.7',
      createdAt: when,
    });
    return agreedToMarketing(id)
      ? [record(true, at, 0)]
      : [record(true, at, 0), record(false, new Date(at.getTime() + 5 * MINUTE_MS), 1)];
  });
  const consentReport = await insertRows(db, s.consentRecords, consents);
  await syncIdentity(db, s.consentRecords);
  await syncIdentity(db, s.checkoutSessions);
  return [customerReport, sessionReport, consentReport];
}
