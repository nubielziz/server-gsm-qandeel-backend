// Seeder of the retail accounts (decision 064): the demo's 30 storefront customers as accounts of the retail rank, with the sign-in side
// of the account on the same row, mapped as the frontend mocks map them (src/features/accounts/mocks/seed.ts): the same names, emails,
// countries and statuses, under the numbers `100 + N` (`c3` is account 103) so an old customer number never names a merchant. Each one has
// its row of the legacy id map, so the old number still finds the account. The demo's eight TACs are written once, by the storefront seeder
// (scripts/seed/storefront.ts).
//
// The storefront (B2C) orders, their payments and consents are written by the storefront money seeder (feature 16, scripts/seed/b2c.ts), which
// runs after this one and uses these account rows (it adds none); `total_spent` stays 0. `risk_assessments` come with feature 18.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { PasswordHasher } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { accountIdOfDemo } from './account-ids';
import { DEV_PASSWORD } from './dev-credentials';
import { type DemoSeed, demoNumericId, demoRows, toDate } from './demo-state';
import { type SeedReport, insertRows, retailGroupId, syncAccountIdentity } from './helpers';

/** A customer of the demo seed, as the demo stores it (the fields the seed uses). */
interface DemoCustomer {
  id: string;
  name: string;
  email: string;
  country: string;
  cur: string;
  hasAccount: boolean;
  optIn: boolean;
  status: 'active' | 'suspended' | 'blocked';
  created: number;
  notes: string;
  phone: string;
  emailVerified: boolean;
  createdBy: 'self' | 'checkout' | 'admin';
  lastLogin: number | null;
  pwChangedAt: number | null;
  mustChangePw: boolean;
  suspendedAt: number | null;
  suspendedReason: string;
}

/** The staff id the mock gives a customer "added by the team" (the seed has none, so nobody is listed as the creator). */
const MOCK_STAFF_ID = 1;

/**
 * Seeds the retail accounts and their rows of the legacy id map.
 *
 * Why: the console pointed at the real API should show the accounts it knew from its mock. The numbers are the mock's (`c1` is 101), the
 * currency is the demo's `cur` (the money seeder inserted the demo currencies first), the rank is the retail one. An account that can sign
 * in has no password (accounts choose theirs through a link); the demo's `mustChangePw` and `pwChangedAt` are kept. A demo customer
 * without an account is a guest row (`has_account = false`: no password, no username). Idempotent: rows that exist are skipped.
 *
 * Side effects: inserts `clients` and `account_legacy_ids` rows, moves the accounts' id sequence to the highest demo number (130).
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns the reports of `clients` and `account_legacy_ids`
 * @throws {Error} when the retail rank does not exist (the identity seeder has not run)
 */
export async function seedCustomers(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const demoCustomers = demoRows<DemoCustomer>(demo, 'customers');
  const groupId = await retailGroupId(db);
  const accounts = await insertRows(
    db,
    s.clients,
    demoCustomers.map((c) => ({
      id: accountIdOfDemo(c.id),
      email: c.email,
      emailVerifiedAt: c.emailVerified ? toDate(c.created) : null,
      name: c.name,
      phone: c.phone,
      country: c.country,
      currency: c.cur,
      groupId,
      hasAccount: c.hasAccount,
      createdBy: c.createdBy === 'admin' ? MOCK_STAFF_ID : null,
      marketingOptIn: c.optIn,
      status: c.status,
      suspendedAt: toDate(c.suspendedAt),
      suspendedReason: c.suspendedReason === '' ? null : c.suspendedReason,
      internalNotes: c.notes,
      // The sign-in side belongs to an account that can sign in; a guest row has none (`clients_guest_check`).
      passwordHash: null,
      mustChangePassword: c.hasAccount && c.mustChangePw,
      passwordChangedAt: c.hasAccount ? toDate(c.pwChangedAt) : null,
      lastLoginAt: toDate(c.lastLogin),
      createdAt: toDate(c.created)!,
      updatedAt: toDate(c.created)!,
    })),
  );
  // The old customer numbers keep finding their account: `customer 7` is account 107, never merchant 7.
  const legacy = await insertRows(
    db,
    s.accountLegacyIds,
    demoCustomers.map((c) => ({
      legacyType: 'customer' as const,
      legacyId: demoNumericId(c.id),
      accountId: accountIdOfDemo(c.id),
    })),
  );
  await syncAccountIdentity(db);
  return [accounts, legacy];
}

/**
 * Gives the seeded retail accounts the development password `demo-password`.
 *
 * Why: a developer signs in to the storefront API as a demo customer (README "Local sign-in"). It only fills what is empty
 * (`password_hash IS NULL`) and leaves an account that must change a temporary password alone, so running the seed again never overwrites a
 * password someone changed. Only the accounts that came from the demo's customers are touched (the ones with a row of the legacy id map of
 * type `customer`): a merchant is invited by link, and an account somebody made later chose its own password. Development only:
 * `bun run db:seed` calls it when NODE_ENV=development.
 *
 * @param db the transaction to write with
 * @param config the application configuration (the argon2 cost)
 * @returns how many accounts got a password (`inserted`) and how many already had one (`existing`)
 */
export async function seedCustomerDevCredentials(db: DbExecutor, config: AppConfig): Promise<SeedReport> {
  const hasher = new PasswordHasher(config);
  const demoCustomers = db
    .select({ id: s.accountLegacyIds.accountId })
    .from(s.accountLegacyIds)
    .where(eq(s.accountLegacyIds.legacyType, 'customer'));
  const accounts = await db
    .select({ id: s.clients.id })
    .from(s.clients)
    .where(
      and(
        inArray(s.clients.id, demoCustomers),
        eq(s.clients.hasAccount, true),
        eq(s.clients.mustChangePassword, false),
      ),
    );
  let inserted = 0;
  for (const account of accounts) {
    const written = await db
      .update(s.clients)
      .set({ passwordHash: await hasher.hash(DEV_PASSWORD) })
      .where(and(eq(s.clients.id, account.id), isNull(s.clients.passwordHash)))
      .returning({ id: s.clients.id });
    inserted += written.length;
  }
  return { table: 'clients (passwords)', inserted, existing: accounts.length - inserted };
}
