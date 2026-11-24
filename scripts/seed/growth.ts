// Seeder of the funnel's checkouts (feature 19): the demo's 238 checkouts that were left (`S.checkouts`) as `checkout_sessions`, each with the
// guest account of its email (a `clients` row with `has_account = false`, decision 064) and the marketing answer the console mock makes up for it.
// The ids are the demo's (`CK-3001` is 3001). Runs after the money seed (currencies), the catalog seed (services) and the identity seed (the
// retail rank).
//
// Mapping, as the frontend mock maps it (src/features/checkouts/mocks/store.ts): the basket is in the buyer's currency, so the USD gross is
// `gross / rate` and the session keeps that currency's current rate; `converted` becomes status `paid` with no order, because the storefront
// orders arrive with feature 16's seed; the answer to marketing is agreed for about seven in ten (the mock's `agreedToMarketing`), and a few of
// the others have a withdrawn record.
//
// Ids of rows this seeder invents (the guest accounts and the consent records) start at 900 000, so the seeder of the retail accounts that
// writes the demo's own account numbers never meets them whichever runs first. The accounts' id sequence stays below them (the sync of the
// other seeders ignores the invented range), so the next account made in a development database is 131.
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { CHECKOUT_SESSION_TTL_MINUTES } from '../../src/modules/customers';
import { INVENTED_ACCOUNT_ID_FIRST } from './account-ids';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, retailGroupId, syncIdentity } from './helpers';

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

/** Stable per checkout: the same people agree on every run (the mock's `agreedToMarketing`). */
export const agreedToMarketing = (id: number): boolean => (id * 7) % 10 < 7;

/** Of the buyers who did not agree, those who once agreed and then withdrew (every fifth): a refusal record, not a missing one. */
const withdrew = (id: number): boolean => !agreedToMarketing(id) && id % 5 === 0;

/**
 * Seeds the demo's checkouts that were left.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns the reports of the guest accounts (labelled `customers`: they are the buyers of the left checkouts), `checkout_sessions` and
 *   `consent_records`
 * @throws {Error} when there are checkouts and the retail rank does not exist (the identity seeder has not run)
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
  // A buyer who left several checkouts is one guest account, and the newest checkout speaks for them (their switch and country).
  const newest = new Map<string, DemoCheckout>();
  const firstSeen = new Map<string, number>();
  for (const row of checkouts) {
    const key = row.email.toLowerCase();
    const seen = newest.get(key);
    if (!seen || row.created > seen.created) newest.set(key, row);
    firstSeen.set(key, Math.min(row.created, firstSeen.get(key) ?? row.created));
  }
  const emails = [...newest.keys()];

  // One guest account per address: the guest rows are their own set of emails (a signed-out checkout never joins a login account), so an
  // address that is already a guest row (the retail seed's guests) keeps its row.
  const groupId = await retailGroupId(db);
  const guestReport = await insertRows(
    db,
    s.clients,
    emails.map((email, index) => {
      const row = newest.get(email)!;
      const agreed = agreedToMarketing(demoNumericId(row.id));
      return {
        id: INVENTED_ACCOUNT_ID_FIRST + index,
        email,
        // A checkout that gave no name leaves an empty one, as the backend does.
        name: '',
        country: row.country,
        groupId,
        hasAccount: false,
        marketingOptIn: agreed,
        // The demo's buyers who agreed are people whose address was confirmed (decision 053): only then does the answer count, as the mock shows.
        emailVerifiedAt: agreed ? toDate(row.created)! : null,
        createdAt: toDate(firstSeen.get(email))!,
        updatedAt: toDate(row.created)!,
      };
    }),
  );
  // The sequence of the accounts is not synced here: the invented numbers would drag it to 900 000.
  const guestIds = new Map(
    (
      await db
        .select({ id: s.clients.id, email: sql<string>`lower(${s.clients.email})` })
        .from(s.clients)
        .where(and(eq(s.clients.hasAccount, false), inArray(sql`lower(${s.clients.email})`, emails)))
    ).map((row) => [row.email, row.id]),
  );

  const sessions = checkouts.map((row) => {
    const id = demoNumericId(row.id);
    const rate = rates.get(row.cur) ?? 1;
    const created = toDate(row.created)!;
    return {
      id,
      token: randomBytes(16).toString('base64url'),
      accountId: guestIds.get(row.email.toLowerCase()) ?? null,
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
      createdAt: created,
      updatedAt: created,
    };
  });
  const sessionReport = await insertRows(db, s.checkoutSessions, sessions);

  const consents = checkouts.flatMap((row) => {
    const id = demoNumericId(row.id);
    const accountId = guestIds.get(row.email.toLowerCase());
    if (accountId === undefined || (!agreedToMarketing(id) && !withdrew(id))) return [];
    const at = toDate(row.created)!;
    const record = (granted: boolean, when: Date, offset: number) => ({
      id: INVENTED_ACCOUNT_ID_FIRST + id * 2 + offset,
      subjectType: 'account' as const,
      subjectId: accountId,
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
  return [{ ...guestReport, table: 'customers' }, sessionReport, consentReport];
}
