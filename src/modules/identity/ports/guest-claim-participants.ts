// The registry of the owners of guest records that move to an account when its holder proves the mailbox (decision 064). Complete here: each
// module registers its participant at boot.
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../infra/db';

/** The two rows a claim moves records between. */
export interface GuestClaimIds {
  /** The guest row (an email only, no login). */
  readonly guestId: number;
  /** The retail account that proved the mailbox. */
  readonly accountId: number;
}

/**
 * Moves one module's records of the guest row to the account.
 *
 * Every participant locks its rows `FOR UPDATE NOWAIT`: a row another request holds (a dispute webhook, a refund approval) throws the lock
 * error (SQLSTATE 55P03) that the claim catches and answers as `busy`; it never waits.
 *
 * @param tx the claim's transaction, inside the savepoint the claim opened
 * @param ids the guest row and the account
 * @returns how many records moved
 */
export type GuestClaimMove = (tx: Transaction, ids: GuestClaimIds) => Promise<number>;

/**
 * The name the orders participant registers under: its count is the `claimedOrders` of the answer.
 *
 * Why: the registry keys every participant by a free name and the answer of the link exchange names only the orders; the other counts
 * (consents, payments, tickets, and so on) go to the audit row.
 */
export const ORDERS_PARTICIPANT = 'orders';

/**
 * What a participant throws to refuse the claim for now.
 *
 * Why: a guest row that still has an open checkout session, a pending payment or any ledger account is mid-flight: moving its records
 * would race the work that holds them. Only the module that owns those rows can see that, so its participant throws this (a lock
 * conflict, SQLSTATE 55P03, has the same effect). The claim rolls back to its savepoint and answers `busy`; nothing moves, and the
 * sign-in that carried it still succeeds.
 */
export class GuestClaimBusy extends Error {
  /**
   * @param reason a short English phrase for the log (never a name, an email or an amount)
   */
  constructor(readonly reason: string) {
    super(`The guest claim gave up: ${reason}`);
    this.name = 'GuestClaimBusy';
  }
}

/**
 * The participants of the guest-order claim: orders, checkout sessions and consents, payments, invoices, refunds and disputes, risk
 * assessments, tickets, messages and their files.
 *
 * Why: the claim is offered after the mailbox was proven, only to a retail account; the orders of a guest checkout, and everything that
 * hangs on them, then belong to the account. Identity runs the claim but cannot know every table that carries a buyer, so each owning
 * module registers a mover and the claim calls them all in one transaction.
 *
 * Side effects: none of its own; each participant updates its module's tables.
 *
 * @see POST /store/v1/auth/verify
 */
@Injectable()
export class GuestClaimParticipants {
  private readonly moves = new Map<string, GuestClaimMove>();

  /**
   * Adds a participant.
   *
   * @param name the name of the participant, unique (it keys the counts the claim records)
   * @param move the mover
   * @throws {Error} when the name is already registered (a boot-time programming error)
   */
  register(name: string, move: GuestClaimMove): void {
    if (this.moves.has(name)) throw new Error(`A guest claim participant named "${name}" is already registered`);
    this.moves.set(name, move);
  }

  /**
   * Calls every participant, in registration order.
   *
   * @param tx the claim's transaction
   * @param ids the guest row and the account
   * @returns how many records each participant moved, by name
   * @throws {Error} the lock error (55P03) of the first participant that meets a row held by another request: the claim rolls back to its savepoint
   */
  async moveAll(tx: Transaction, ids: GuestClaimIds): Promise<Readonly<Record<string, number>>> {
    const counts: Record<string, number> = {};
    for (const [name, move] of this.moves) counts[name] = await move(tx, ids);
    return counts;
  }

  /**
   * Lists the registered names.
   *
   * @returns the names in registration order (the wiring test reads it)
   */
  names(): readonly string[] {
    return [...this.moves.keys()];
  }
}
