// AccountDirectory: the one reader and locker of account rows other modules use, and the only writer of guest rows (decision 064).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { DbExecutor } from '../../../infra/db';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import type { ClientStatus } from '../db/schema';
import {
  type AccountRow,
  findAccountRowById,
  findGuestRowByEmail,
  findLoginRowByEmail,
  insertGuestRow,
  lockAccountRow,
  lockGuestRowNoWait,
  normalizeEmail,
} from './account-directory.repository';
import { type RankKind, rankKindOf } from '../ports/rank-kind';

/**
 * An account as other modules may know it: who it is, whether it can sign in, and which rights its rank gives.
 *
 * Why: every module that needs "the account" reads this one shape instead of the `clients` row, so no other module learns the table
 * and nothing secret (a hash, a TOTP secret) crosses a module boundary (decision 064).
 */
export interface AccountRecord {
  readonly id: number;
  readonly email: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly groupId: number;
  /** The rights of the account's rank, read through `RankGroupReads` and never from `client_groups` directly. */
  readonly rankKind: RankKind;
  /** False for a guest row: an email that ordered without signing up. A guest cannot sign in. */
  readonly hasAccount: boolean;
  /** True once a password exists (an invited account has none until it opens its link). */
  readonly hasPassword: boolean;
  readonly emailVerifiedAt: Date | null;
  /** The two-letter country the account chose, or an empty string. */
  readonly country: string;
  /** The currency the account chose, or `null` for the shop's default. */
  readonly currency: string | null;
}

/** What {@link AccountDirectory.findOrCreateGuest} needs to make a guest row. */
export interface GuestInput {
  /** The email as typed; stored trimmed and in lower case. */
  readonly email: string;
  /** The name the visitor typed; an existing guest row keeps its own. */
  readonly name?: string | undefined;
  readonly country?: string | undefined;
  /** A currency code of the `currencies` table. */
  readonly currency?: string | undefined;
}

/** The answer of {@link AccountDirectory.findOrCreateGuest}. */
export interface GuestResult {
  readonly account: AccountRecord;
  /** True when this call made the row, false when a guest row already held the email. */
  readonly created: boolean;
}

/** How many times {@link AccountDirectory.findOrCreateGuest} reads and inserts before it gives up (one retry). */
const GUEST_ROUNDS = 2;

/**
 * Finds, locks and (for guests) makes account rows.
 *
 * Why: one account type serves merchants and shoppers, and an email can belong to two rows at once: one with a login and one guest row
 * (a visitor who ordered without signing up). The two partitions are never mixed: `findLoginByEmail` is the only way to find the row of
 * a login by its email, so sign-in, password reset and the sign-in lock can never act on a guest row, whatever order the rows were made
 * in; `findGuestByEmail` and `findOrCreateGuest` only ever see guest rows. The class is also the only writer of guest rows
 * (decision 064).
 *
 * Side effects: `findOrCreateGuest` may insert a guest row; the `lock*` methods take row locks that last until the caller's
 * transaction ends. Time comes from the injected clock (decision 031). The rank kind of every record is read through
 * `RankGroupReads` of the catalog module.
 *
 * @see decision 064
 */
@Injectable()
export class AccountDirectory {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ranks: RankGroupReads,
  ) {}

  /**
   * Finds an account of any kind (a login row or a guest row) by id.
   *
   * @param db the database or a transaction
   * @param id the account id
   * @returns the account, or `undefined`
   */
  async findById(db: DbExecutor, id: number): Promise<AccountRecord | undefined> {
    return this.recordOf(db, await findAccountRowById(db, id));
  }

  /**
   * Finds the row with a login that holds an email: the only email lookup of a login row.
   *
   * Why: password sign-in (the three sign-in routes), both forgot-password routes, the sign-in lock and the sign-in limiter all come
   * here, so a guest row with the same email is never what they find (decision 064). The lookup ignores case and surrounding space.
   *
   * @param db the database or a transaction
   * @param email the email as typed
   * @returns the login row, or `undefined` when no account with a login holds the email
   */
  async findLoginByEmail(db: DbExecutor, email: string): Promise<AccountRecord | undefined> {
    return this.recordOf(db, await findLoginRowByEmail(db, email));
  }

  /**
   * Finds the guest row that holds an email.
   *
   * @param db the database or a transaction
   * @param email the email as typed
   * @returns the guest row, or `undefined` when no guest row holds the email (a login row with the same email does not count)
   */
  async findGuestByEmail(db: DbExecutor, email: string): Promise<AccountRecord | undefined> {
    return this.recordOf(db, await findGuestRowByEmail(db, email));
  }

  /**
   * Returns the guest row of an email, making it when nobody used the address as a guest yet.
   *
   * Why: a visitor who orders or writes without signing up needs a row to belong to. The guest partition has one row per email, so two
   * requests for one new address end with one row: the loser inserts nothing (`ON CONFLICT (lower(email)) WHERE NOT has_account DO
   * NOTHING`) and reads the winner's row. When that row was turned into an account in between, the second round inserts a new guest
   * row. The answer is never a login row, whatever its rank: a visitor typing a merchant's email gets a guest row of its own and nothing
   * attaches to the merchant. The row holds the retail rank and the status `active`; whether a guest may order is the caller's rule.
   *
   * Side effects: may insert a `clients` row (a guest). Needs the default isolation level (read committed), so the second read sees
   * the row another transaction just committed.
   *
   * @param tx the caller's transaction
   * @param guest the email as typed, and the optional name, country and currency of a new row
   * @returns the guest row and whether this call made it
   * @throws {Error} when the row was neither found nor made after the retry (not expected)
   */
  async findOrCreateGuest(tx: DbExecutor, guest: GuestInput): Promise<GuestResult> {
    const email = normalizeEmail(guest.email);
    for (let round = 1; round <= GUEST_ROUNDS; round++) {
      const existing = await findGuestRowByEmail(tx, email);
      if (existing) return { account: await this.requireRecord(tx, existing), created: false };
      const id = await insertGuestRow(tx, {
        email,
        name: guest.name ?? '',
        country: guest.country ?? '',
        currency: guest.currency ?? null,
        groupId: await this.ranks.retailGroupId(tx),
        now: this.clock.now(),
      });
      if (id !== undefined) {
        const row = await findAccountRowById(tx, id);
        if (row) return { account: await this.requireRecord(tx, row), created: true };
      }
      // A guest row held the email when the insert ran. Round two reads it, or, when it became an account meanwhile, makes a new one.
    }
    throw new Error('A guest account was neither created nor found.');
  }

  /**
   * Reads an account and holds its row against deletion and re-keying until the transaction ends (`FOR KEY SHARE`).
   *
   * Why: a use case that only needs the account to stay as it is (placing an order, opening a checkout) takes this lock; it does not
   * block another reader that takes it too, but it makes a rank change wait.
   *
   * Side effects: a row lock held until the transaction ends.
   *
   * @param tx the transaction
   * @param id the account id
   * @returns the account as it is now, or `undefined`
   */
  async lockForKeyShare(tx: DbExecutor, id: number): Promise<AccountRecord | undefined> {
    return this.recordOf(tx, await lockAccountRow(tx, id, 'key share'));
  }

  /**
   * Reads an account and holds its row against every other writer until the transaction ends (`FOR UPDATE`).
   *
   * Why: a change of the account itself (a rank change, a status change, an erasure) takes this lock first and decides on what it
   * reads, so a payment or an order that started a moment earlier is either seen or waited for.
   *
   * Side effects: a row lock held until the transaction ends.
   *
   * @param tx the transaction
   * @param id the account id
   * @returns the account as it is now, or `undefined`
   */
  async lockForUpdate(tx: DbExecutor, id: number): Promise<AccountRecord | undefined> {
    return this.recordOf(tx, await lockAccountRow(tx, id, 'update'));
  }

  /**
   * Locks the guest row of an email without waiting (`FOR UPDATE NOWAIT`).
   *
   * Why: moving a guest's orders to an account after the mailbox was proven must never queue behind a payment, a dispute or a refund
   * that holds the guest's rows: the claim runs in a savepoint, catches the lock error and skips.
   *
   * Side effects: a row lock held until the transaction ends.
   *
   * @param tx the transaction (the claim's savepoint)
   * @param email the email as typed
   * @returns the guest row, or `undefined` when no guest row holds the email
   * @throws {Error} the database's lock error (SQLSTATE 55P03) when another transaction holds the row; the caller catches it
   */
  async lockGuestNoWait(tx: DbExecutor, email: string): Promise<AccountRecord | undefined> {
    return this.recordOf(tx, await lockGuestRowNoWait(tx, email));
  }

  private async recordOf(db: DbExecutor, row: AccountRow | undefined): Promise<AccountRecord | undefined> {
    return row ? this.requireRecord(db, row) : undefined;
  }

  /** Adds the rank kind to a row. A rank that cannot be read gives retail rights: the check fails closed. */
  private async requireRecord(db: DbExecutor, row: AccountRow): Promise<AccountRecord> {
    const kind = await this.ranks.kindOf(db, row.groupId);
    return { ...row, rankKind: rankKindOf(kind ?? '') };
  }
}
