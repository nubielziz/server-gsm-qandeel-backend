// Drizzle queries on ledger_accounts for the ledger writer: lock accounts by identity in id order, open missing ones,
// write the new balances. Only postTransaction and the wallet use cases call these (decision 024).
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { type LedgerAccountKind, type LedgerOwnerType, ledgerAccounts } from '../db/schema';

/** The identity of an account: unique `(kind, owner_type, owner_id, currency)` (decision 024). */
export interface AccountIdentity {
  readonly kind: LedgerAccountKind;
  readonly ownerType: LedgerOwnerType | undefined;
  readonly ownerId: number | undefined;
  readonly currency: string;
}

/** An account row as the writer needs it. */
export interface AccountRow {
  readonly id: number;
  readonly kind: LedgerAccountKind;
  readonly ownerType: LedgerOwnerType | null;
  readonly ownerId: number | null;
  readonly currency: string;
}

/** An account row that is locked, with the figures the posting changes. */
export interface LockedAccount extends AccountRow {
  /** Balance in the account's normal sign. */
  readonly balance: string;
  readonly overdraftLimit: string;
  readonly version: number;
}

const columns = {
  id: ledgerAccounts.id,
  kind: ledgerAccounts.kind,
  ownerType: ledgerAccounts.ownerType,
  ownerId: ledgerAccounts.ownerId,
  currency: ledgerAccounts.currency,
};

function identityCondition(identity: AccountIdentity) {
  return and(
    eq(ledgerAccounts.kind, identity.kind),
    identity.ownerType === undefined
      ? isNull(ledgerAccounts.ownerType)
      : eq(ledgerAccounts.ownerType, identity.ownerType),
    identity.ownerId === undefined ? isNull(ledgerAccounts.ownerId) : eq(ledgerAccounts.ownerId, identity.ownerId),
    eq(ledgerAccounts.currency, identity.currency),
  );
}

/**
 * Opens accounts that do not exist yet.
 *
 * Why: merchants' accounts are opened with the merchant (`MerchantAccounts.open`); this is the safety fallback of
 * decision 024 ("created inside the transaction that first needs them"), and it creates the system accounts of a fresh
 * database. `ON CONFLICT DO NOTHING` makes two racing posts open one account.
 *
 * Side effects: inserts `ledger_accounts` rows.
 *
 * @param db the transaction
 * @param identities the accounts to open
 */
export async function openAccounts(db: DbExecutor, identities: readonly AccountIdentity[]): Promise<void> {
  if (identities.length === 0) return;
  await db
    .insert(ledgerAccounts)
    .values(
      identities.map((identity) => ({
        kind: identity.kind,
        ownerType: identity.ownerType ?? null,
        ownerId: identity.ownerId ?? null,
        currency: identity.currency,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Locks the accounts of some identities `FOR UPDATE` in id order and reads their figures, in one statement.
 *
 * Why: the common posting finds every account already open, so finding and locking them is one round trip. The caller opens
 * the missing ones (a short list) and calls this again.
 *
 * @param tx the transaction
 * @param identities the accounts to lock
 * @returns the locked accounts that exist, ascending by id
 */
export async function lockAccountsByIdentity(
  tx: DbExecutor,
  identities: readonly AccountIdentity[],
): Promise<LockedAccount[]> {
  if (identities.length === 0) return [];
  return tx
    .select({
      ...columns,
      balance: ledgerAccounts.balance,
      overdraftLimit: ledgerAccounts.overdraftLimit,
      version: ledgerAccounts.version,
    })
    .from(ledgerAccounts)
    .where(or(...identities.map(identityCondition)))
    .orderBy(ledgerAccounts.id)
    .for('update');
}

/**
 * Writes the new balances of locked accounts and bumps their versions, in one statement.
 *
 * @param tx the transaction that holds the locks
 * @param balances the account ids with their new balance, in the account's normal sign
 * @param now the posting time, from the injected clock
 */
export async function writeBalances(
  tx: DbExecutor,
  balances: ReadonlyArray<{ readonly id: number; readonly balance: Money }>,
  now: Date,
): Promise<void> {
  if (balances.length === 0) return;
  const values = sql.join(
    balances.map((entry) => sql`(${entry.id}::bigint, ${entry.balance.toWire()}::numeric)`),
    sql`, `,
  );
  await tx.execute(
    sql`update ${ledgerAccounts} as a
        set balance = v.balance, version = a.version + 1, updated_at = ${now}
        from (values ${values}) as v(id, balance)
        where a.id = v.id`,
  );
}
