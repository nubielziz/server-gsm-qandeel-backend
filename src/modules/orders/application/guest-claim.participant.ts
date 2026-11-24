// The orders module's participant of the guest-order claim (decision 064): the store orders of the guest row move to the account whose holder
// just proved the mailbox.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../../infra/db';
import { GuestClaimParticipants, type GuestClaimIds, ORDERS_PARTICIPANT } from '../../identity';
import { orders } from '../db/schema';
import { prepaidOrderSql } from '../domain/door';

/**
 * Moves the store orders of a guest row to the account.
 *
 * Why: a visitor who ordered in the shop without signing up leaves a guest row; when the same email proves its mailbox with the sign-in link and
 * the visitor asks for it, the orders become the account's (decision 064, the guest-order claim). Only orders of the `store` door can
 * belong to a guest, so only those move. The count is the `claimedOrders` of the link exchange, which is why the participant registers under
 * `ORDERS_PARTICIPANT`.
 *
 * Locks: the rows are taken `FOR UPDATE NOWAIT` in id order. An order another request holds (a supplier answer being written, a staff action)
 * throws the lock error (SQLSTATE 55P03), which the claim catches and answers as `busy`: it never waits, so it cannot deadlock with a
 * transition that holds an order and then asks for the account row. The claim already holds the account row, then the guest row.
 *
 * Side effects: updates `orders.account_id` (and `updated_at`) of the guest row's orders in the claim's transaction; registers itself with
 * `GuestClaimParticipants` when the module starts (a repeated name is a boot error). The history stays as it was written: the events of a
 * moved order, the outbox rows already queued and the ledger lines keep naming the guest row's id.
 *
 * @see POST /store/v1/auth/verify
 */
@Injectable()
export class OrdersGuestClaimParticipant implements OnModuleInit {
  constructor(private readonly participants: GuestClaimParticipants) {}

  /** Adds the participant to the claim. */
  onModuleInit(): void {
    this.participants.register(ORDERS_PARTICIPANT, (tx, ids) => this.move(tx, ids));
  }

  /**
   * Moves the guest row's store orders to the account.
   *
   * @param tx the claim's transaction, inside its savepoint
   * @param ids the guest row and the account
   * @returns how many orders moved
   * @throws {Error} the lock error (SQLSTATE 55P03) when another request holds one of the orders: the claim answers `busy`
   */
  async move(tx: Transaction, ids: GuestClaimIds): Promise<number> {
    const locked = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.accountId, ids.guestId), prepaidOrderSql(sql`${orders.source}`)))
      .orderBy(orders.id)
      .for('update', { noWait: true });
    if (locked.length === 0) return 0;
    const moved = await tx
      .update(orders)
      .set({ accountId: ids.accountId })
      .where(and(eq(orders.accountId, ids.guestId), prepaidOrderSql(sql`${orders.source}`)))
      .returning({ id: orders.id });
    return moved.length;
  }
}
