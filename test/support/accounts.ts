// Test helpers of the one account type (decision 064): an account of either rank straight into `clients`, a guest, the two ranks every
// account belongs to, and readers of the row. A merchant, a retail account and a guest are rows of one table, told apart by the rank
// (`client_groups.kind`, `b2b` or `b2c_retail`) and by `has_account`.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { parseEnv } from '@src/config';
import { PasswordHasher } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import type { RankKind } from '@src/modules/identity';
import type { TestApp } from './app';
import { testDb } from './db';
import { testInstanceEnv } from './env';

/** The password of every account `makeAccount` creates unless told otherwise. */
export const ACCOUNT_PASSWORD = 'correct-horse-battery';

/** The name of the one retail rank: the migrations insert it, and `resetDb` empties the table that holds it. */
export const RETAIL_GROUP_NAME = 'Storefront retail';

/**
 * Finds the one retail rank (`kind = 'b2c_retail'`) or inserts it.
 *
 * Why: `resetDb` truncates `client_groups`, so the retail row the migrations made is gone, and every retail account and guest needs it
 * (`clients.group_id` is NOT NULL). The insert ignores a conflict, so two helpers that run at once make one row.
 *
 * Side effects: may insert one `client_groups` row.
 *
 * @param db the test database
 * @returns the id of the retail rank
 * @throws {Error} when the name is taken by a merchant rank, so no retail row can be made
 */
export async function ensureRetailGroup(db: Database): Promise<number> {
  const find = () =>
    db.select({ id: s.clientGroups.id }).from(s.clientGroups).where(eq(s.clientGroups.kind, 'b2c_retail')).limit(1);
  const [found] = await find();
  if (found) return found.id;
  await db
    .insert(s.clientGroups)
    .values({ name: RETAIL_GROUP_NAME, kind: 'b2c_retail', sort: 4 })
    .onConflictDoNothing();
  const [made] = await find();
  if (!made) throw new Error(`The retail rank could not be made: a rank already has the name "${RETAIL_GROUP_NAME}".`);
  return made.id;
}

/**
 * Finds the first merchant rank (`kind = 'b2b'`) or inserts the default one, "Standard".
 *
 * Why: a merchant needs a rank of the merchant kind; the first rank of any kind could be the retail one, which would make the account
 * a retail account (the rank is the only thing that tells the two apart).
 *
 * Side effects: may insert one `client_groups` row.
 *
 * @param db the test database
 * @returns the id of the merchant rank
 */
export async function ensureMerchantGroup(db: Database): Promise<number> {
  const find = () =>
    db
      .select({ id: s.clientGroups.id })
      .from(s.clientGroups)
      .where(eq(s.clientGroups.kind, 'b2b'))
      .orderBy(s.clientGroups.id)
      .limit(1);
  const [found] = await find();
  if (found) return found.id;
  await db.insert(s.clientGroups).values({ name: 'Standard', isDefault: true }).onConflictDoNothing();
  const [made] = await find();
  if (!made) throw new Error('The merchant rank could not be made.');
  return made.id;
}

let standaloneHasher: PasswordHasher | undefined;

/** The hasher of the running app, or one built from the test configuration when a helper runs without an app. */
function hasherOf(t: TestApp | undefined): PasswordHasher {
  if (t) return t.app.get(PasswordHasher);
  standaloneHasher ??= new PasswordHasher(parseEnv({ NODE_ENV: 'test', ...testInstanceEnv() }));
  return standaloneHasher;
}

/** What a test can change about the account `makeAccount` creates. */
export type AccountOverrides = Partial<typeof s.clients.$inferInsert> & {
  /** The rank kind: `merchant` takes a merchant rank and a username, `retail` the one retail rank and no username. */
  readonly rank: RankKind;
  /** A guest: no login (`has_account` false), no password, no username. Only with the retail rank. */
  readonly guest?: boolean;
  /** The password to hash (default {@link ACCOUNT_PASSWORD}); `null` stores none (an account that was invited, or signs in by link). */
  readonly password?: string | null;
  /** The database (or transaction) handle to write with; default the shared test pool. */
  readonly db?: Database;
};

/** What `makeAccount` creates. */
export interface MadeAccount {
  readonly id: number;
  readonly email: string;
  readonly rank: RankKind;
  readonly groupId: number;
  /** The clear password that was hashed, or `null` when none was stored. */
  readonly password: string | null;
  readonly row: typeof s.clients.$inferSelect;
}

/**
 * Creates an active account of a rank, with a password unless told otherwise.
 *
 * Why: one factory for the three kinds of rows of the one account table, so a test names the rank it needs and gets exactly the columns
 * a real row of that rank has (a merchant: a username; a retail account: none; a guest: no login, no password, no username, which the
 * `clients_guest_check` demands).
 *
 * Side effects: may insert the rank row (`ensureRetailGroup`, `ensureMerchantGroup`) and inserts one `clients` row.
 *
 * @param options the rank and the columns to change; `guest` and `password` are handled here
 * @returns the id, the email, the rank, the password and the stored row
 * @throws {Error} for a guest of the merchant rank
 */
export async function makeAccount(options: AccountOverrides): Promise<MadeAccount>;
/**
 * The same, hashing the password with the running app's hasher.
 *
 * @param t the running test app
 * @param options the rank and the columns to change
 */
export async function makeAccount(t: TestApp, options: AccountOverrides): Promise<MadeAccount>;
export async function makeAccount(first: TestApp | AccountOverrides, second?: AccountOverrides): Promise<MadeAccount> {
  const t = second === undefined ? undefined : (first as TestApp);
  const { rank, guest, password, db: given, ...columns } = second ?? (first as AccountOverrides);
  if ((guest === true || columns.hasAccount === false) && rank === 'merchant') {
    throw new Error('A guest holds the retail rank: it cannot be a merchant.');
  }
  const db = given ?? (await testDb()).db;
  const groupId =
    columns.groupId ?? (rank === 'merchant' ? await ensureMerchantGroup(db) : await ensureRetailGroup(db));
  const unique = randomUUID();
  // an explicit `hasAccount: false` makes a guest too: a guest row cannot hold a password (`clients_guest_check`)
  const login = guest !== true && columns.hasAccount !== false;
  const plain = !login || password === null ? null : (password ?? ACCOUNT_PASSWORD);
  const passwordHash = plain === null ? null : await hasherOf(t).hash(plain);
  const [row] = await db
    .insert(s.clients)
    .values({
      email: `${rank === 'merchant' ? 'merchant' : 'customer'}-${unique}@example.com`,
      name: rank === 'merchant' ? 'Test Merchant' : 'Test Customer',
      ...(rank === 'merchant' ? {} : { country: 'GB' }),
      ...(rank === 'merchant' && login ? { username: `merchant-${unique}` } : {}),
      groupId,
      hasAccount: login,
      status: 'active',
      // retired column: it exists until the contract release and is unique, so a new row still carries a value
      referralCode: `REF-${unique}`,
      // a retail account chose its password itself (a change date); a merchant is made by staff and has none until it changes it
      ...(passwordHash === null
        ? {}
        : { passwordHash, ...(rank === 'merchant' ? {} : { passwordChangedAt: new Date() }) }),
      ...columns,
    })
    .returning();
  return { id: row!.id, email: row!.email, rank, groupId, password: plain, row: row! };
}

/**
 * Reads an account row back, whatever its rank.
 *
 * @param id the account
 * @returns the row
 */
export async function accountRow(id: number): Promise<typeof s.clients.$inferSelect> {
  const { db } = await testDb();
  const [row] = await db.select().from(s.clients).where(eq(s.clients.id, id));
  return row!;
}
