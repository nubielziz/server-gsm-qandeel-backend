// Drizzle queries on `customer_credentials` (customers module): the password hash and the forced-change flag of the account's
// sign-in. Only the hash is stored, never a password. (The failed-attempt count and the lock live in the cache Redis.)
import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type CustomerCredential, customerCredentials } from '../db/schema';

/**
 * Finds the credentials of a customer.
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @param lock lock the row `FOR UPDATE`
 * @returns the row, or `undefined` for a guest
 */
export async function findCredentials(
  db: DbExecutor,
  customerId: number,
  lock = false,
): Promise<CustomerCredential | undefined> {
  const query = db.select().from(customerCredentials).where(eq(customerCredentials.customerId, customerId)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** What a password change writes. */
export interface PasswordWrite {
  /** The argon2id hash; `null` keeps an account without a password (an invitation not yet used). */
  readonly passwordHash: string | null;
  readonly mustChangePassword: boolean;
  /** The time the password was set; `null` when no password was set. */
  readonly passwordChangedAt: Date | null;
  /** The staff member who set it; `null` for the customer's own change. */
  readonly updatedBy: number | null;
  readonly now: Date;
}

/**
 * Creates or replaces the credentials of a customer.
 *
 * Why: an account's credentials row exists from the moment it is created (an invitation has no password yet), and a password
 * change or set clears the email's failure count in the cache Redis (the caller does it after the commit).
 *
 * Side effects: inserts or updates the `customer_credentials` row.
 *
 * @param db the transaction
 * @param customerId the customer id
 * @param write the password and flags to store
 * @returns the stored row
 */
export async function upsertCredentials(
  db: DbExecutor,
  customerId: number,
  write: PasswordWrite,
): Promise<CustomerCredential> {
  const values = {
    customerId,
    passwordHash: write.passwordHash,
    mustChangePassword: write.mustChangePassword,
    passwordChangedAt: write.passwordChangedAt,
    updatedBy: write.updatedBy,
    createdAt: write.now,
    updatedAt: write.now,
  };
  const [row] = await db
    .insert(customerCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: customerCredentials.customerId,
      set: {
        passwordHash: write.passwordHash,
        mustChangePassword: write.mustChangePassword,
        passwordChangedAt: write.passwordChangedAt,
        updatedBy: write.updatedBy,
        updatedAt: write.now,
      },
    })
    .returning();
  if (!row) throw new Error('Saving customer credentials returned no row.');
  return row;
}

/**
 * Replaces the stored hash by one made at the configured cost, leaving every other column alone.
 *
 * Why: decision 007: a correct password hashed at a lower cost is upgraded at sign-in.
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @param passwordHash the new argon2id hash
 */
export async function replacePasswordHash(db: DbExecutor, customerId: number, passwordHash: string): Promise<void> {
  await db.update(customerCredentials).set({ passwordHash }).where(eq(customerCredentials.customerId, customerId));
}
