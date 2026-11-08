// Seeder of the customers module (feature 14b): the demo's 30 storefront customers with the sign-in side of the accounts, mapped
// as the frontend mocks map them (src/features/customers/mocks/store.ts): the same ids, names, emails, countries and statuses. The
// demo's eight TACs are written once, by the storefront seeder (scripts/seed/storefront.ts).
//
// The storefront (B2C) orders, their payments and consents are written by the storefront money seeder (feature 16, scripts/seed/b2c.ts), which
// runs after this one and uses these customer rows (it adds none); `total_spent` stays 0. `risk_assessments` come with feature 18.
import { and, eq, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { PasswordHasher } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { DEV_PASSWORD } from './dev-credentials';
import { type DemoSeed, demoNumericId, demoRows, toDate } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

/** A customer of the demo seed, as the demo stores it (the fields the seed uses). */
interface DemoCustomer {
  id: string;
  name: string;
  email: string;
  country: string;
  cur: string;
  locale: string;
  hasAccount: boolean;
  optIn: boolean;
  risk: 'low' | 'med' | 'high';
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

/** The demo says `med`, the API says `medium` (MISMATCHES M82). */
const RISK = { low: 'low', med: 'medium', high: 'high' } as const;

/** The staff id the mock gives a customer "added by the team" (the seed has none, so nobody is listed as the creator). */
const MOCK_STAFF_ID = 1;

/**
 * Seeds the customers and the credentials of the accounts.
 *
 * Why: the console pointed at the real API should show the customers it knew from its mock. Ids are the demo's
 * (`c1` is 1), the currency is the demo's `cur` (the money seeder inserted the demo currencies first), a customer the demo marks
 * `med` risk is `medium`. An account's credentials row has no password (accounts choose theirs through a link); the demo's
 * `mustChangePw` and `pwChangedAt` are kept. Idempotent: rows that exist are skipped.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedCustomers(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const demoCustomers = demoRows<DemoCustomer>(demo, 'customers');
  const customers = await insertRows(
    db,
    s.customers,
    demoCustomers.map((c) => ({
      id: demoNumericId(c.id),
      email: c.email,
      emailVerifiedAt: c.emailVerified ? toDate(c.created) : null,
      name: c.name,
      phone: c.phone,
      country: c.country,
      locale: c.locale,
      currency: c.cur,
      hasAccount: c.hasAccount,
      createdBy: c.createdBy === 'admin' ? MOCK_STAFF_ID : null,
      marketingOptIn: c.optIn,
      riskLevel: RISK[c.risk],
      status: c.status,
      suspendedAt: toDate(c.suspendedAt),
      suspendedReason: c.suspendedReason === '' ? null : c.suspendedReason,
      internalNotes: c.notes,
      lastLoginAt: toDate(c.lastLogin),
      createdAt: toDate(c.created)!,
      updatedAt: toDate(c.created)!,
    })),
  );

  const credentials = await insertRows(
    db,
    s.customerCredentials,
    demoCustomers
      .filter((c) => c.hasAccount)
      .map((c) => ({
        customerId: demoNumericId(c.id),
        passwordHash: null,
        mustChangePassword: c.mustChangePw,
        passwordChangedAt: toDate(c.pwChangedAt),
        createdAt: toDate(c.created)!,
        updatedAt: toDate(c.created)!,
      })),
  );

  for (const table of [s.customers, s.customerCredentials]) await syncIdentity(db, table);
  return [customers, credentials];
}

/**
 * Gives the seeded accounts the development password `demo-password`.
 *
 * Why: a developer signs in to the storefront API as a demo customer (README "Local sign-in"). It only fills what is empty
 * (`password_hash IS NULL`) and leaves a customer who must change a temporary password alone, so running the seed again never
 * overwrites a password someone changed. Development only: `bun run db:seed` calls it when NODE_ENV=development.
 *
 * @param db the transaction to write with
 * @param config the application configuration (the argon2 cost)
 * @returns how many credentials got a password (`inserted`) and how many already had one (`existing`)
 */
export async function seedCustomerDevCredentials(db: DbExecutor, config: AppConfig): Promise<SeedReport> {
  const hasher = new PasswordHasher(config);
  const accounts = await db
    .select({ customerId: s.customerCredentials.customerId, hash: s.customerCredentials.passwordHash })
    .from(s.customerCredentials)
    .where(eq(s.customerCredentials.mustChangePassword, false));
  let inserted = 0;
  for (const account of accounts) {
    const written = await db
      .update(s.customerCredentials)
      .set({ passwordHash: await hasher.hash(DEV_PASSWORD) })
      .where(and(eq(s.customerCredentials.customerId, account.customerId), isNull(s.customerCredentials.passwordHash)))
      .returning({ id: s.customerCredentials.id });
    inserted += written.length;
  }
  return { table: 'customer_credentials (passwords)', inserted, existing: accounts.length - inserted };
}
