// OrderActionsService: the staff actions on one order (map domain D, stage 5): accept, reply, reject, reopen, refund, the
// verification decision and the internal note. Each is one transaction through OrderTransitions, so the rules are the state
// machine's and the money, timeline, outbox and audit rows move together.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { SYSTEM_ACTOR } from '../domain/order-timeline';
import { merchantOf } from '../infra/foreign-reads.repository';
import { findOrder, insertEvents, setAdminNote } from '../infra/order.repository';
import { OrderTransitions } from './order-transitions';

/** Who is acting: the signed-in staff member. */
export interface StaffActor {
  readonly staffId: number;
}

/** The audit verb phrases of the demo (ANSWERS audit Q3): the console prints `<actor> <action> <entityLabel>`. */
export const ORDER_AUDIT_ACTIONS = {
  accept: 'accepted order',
  reply: 'completed order',
  reject: 'rejected order',
  reopen: 'reopened order',
  refund: 'refunded order',
  verificationAccept: 'accepted verification of',
  verificationRefund: 'refunded after verification of',
  note: 'added a note to',
  bulkApply: 'applied bulk reply to',
  export: 'exported',
} as const;

/**
 * Runs the staff actions.
 *
 * Why: scenario manual steps 6 to 8 and RULES orders: staff accept a manual order, complete an order with its result, reject
 * it with a reason, reopen or refund a completed one and decide a merchant's verification request. The state machine (decision
 * 025) says what each action may do; this service only supplies who acts, the texts and the audit verb.
 *
 * Side effects: each action runs in one transaction that updates `orders`, posts the ledger move, appends `order_events`,
 * writes the `order.status_changed` outbox row when the status changes and one `audit_logs` row.
 *
 * @see docs/contract/endpoints/orders.md
 */
@Injectable()
export class OrderActionsService {
  constructor(
    private readonly db: DbService,
    private readonly transitions: OrderTransitions,
    private readonly audit: AuditService,
  ) {}

  /**
   * Accepts a manual order: it becomes `processing`, owned by staff.
   *
   * @param staff the acting staff member
   * @param orderId the order
   * @throws {AppError} `NOT_FOUND`, `NOT_MANUAL`, `ORDER_NOT_OPEN`, `ORDER_HELD`
   */
  async accept(staff: StaffActor, orderId: number): Promise<void> {
    await this.run(staff, orderId, { kind: 'accept' }, ORDER_AUDIT_ACTIONS.accept, {});
  }

  /**
   * Completes an order with its result.
   *
   * @param staff the acting staff member
   * @param orderId the order
   * @param reply the result text and the optional comment
   * @throws {AppError} `NOT_FOUND`, `ORDER_NOT_OPEN`, `ORDER_HELD`, `INVALID_TRANSITION` (a lost race)
   */
  async reply(
    staff: StaffActor,
    orderId: number,
    reply: { code: string; comment?: string | undefined },
  ): Promise<void> {
    await this.run(staff, orderId, { kind: 'reply' }, ORDER_AUDIT_ACTIONS.reply, {
      code: reply.code,
      comment: reply.comment,
    });
  }

  /**
   * Rejects an open order with a reason and releases its hold.
   *
   * @param staff the acting staff member
   * @param orderId the order
   * @param reason the buyer-visible reason
   * @throws {AppError} `NOT_FOUND`, `ORDER_NOT_OPEN`, `ORDER_HELD`, `USE_REFUNDS`
   */
  async reject(staff: StaffActor, orderId: number, reason: string): Promise<void> {
    await this.run(staff, orderId, { kind: 'reject' }, ORDER_AUDIT_ACTIONS.reject, { reason });
  }

  /**
   * Reopens a completed order: it goes back to `processing` and its revenue returns to the hold.
   *
   * @param staff the acting staff member
   * @param orderId the order
   * @param reason the optional reason
   * @throws {AppError} `NOT_FOUND`, `ORDER_NOT_COMPLETED`, `ORDER_NOT_OPEN`
   */
  async reopen(staff: StaffActor, orderId: number, reason?: string): Promise<void> {
    await this.run(staff, orderId, { kind: 'reopen' }, ORDER_AUDIT_ACTIONS.reopen, { reason });
  }

  /**
   * Refunds a completed merchant order: the revenue goes back to the wallet, the cost stays.
   *
   * @param staff the acting staff member
   * @param orderId the order
   * @param reason the buyer-visible reason
   * @throws {AppError} `NOT_FOUND`, `ORDER_NOT_COMPLETED`, `USE_REFUNDS` (a storefront order)
   */
  async refund(staff: StaffActor, orderId: number, reason: string): Promise<void> {
    await this.run(staff, orderId, { kind: 'refund' }, ORDER_AUDIT_ACTIONS.refund, { reason });
  }

  /**
   * Decides a verification request: accept the charge, or refund it.
   *
   * @param staff the acting staff member
   * @param orderId the order
   * @param decision `accept` or `refund`
   * @param note the optional note (it becomes the refund's reason)
   * @throws {AppError} `NOT_FOUND`, `NOT_IN_VERIFICATION`, `USE_REFUNDS` (a storefront order)
   */
  async decideVerification(
    staff: StaffActor,
    orderId: number,
    decision: 'accept' | 'refund',
    note?: string,
  ): Promise<void> {
    await this.run(
      staff,
      orderId,
      { kind: 'verification', decision },
      decision === 'accept' ? ORDER_AUDIT_ACTIONS.verificationAccept : ORDER_AUDIT_ACTIONS.verificationRefund,
      { note },
    );
  }

  /**
   * Adds an internal note: a `note` event and the order's latest note. Never shown to the buyer or in a webhook.
   *
   * @param staff the acting staff member
   * @param orderId the order
   * @param body the note text
   * @throws {AppError} `NOT_FOUND`
   */
  async addNote(staff: StaffActor, orderId: number, body: string): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const order = await findOrder(tx, orderId);
      if (!order) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
      await setAdminNote(tx, orderId, body);
      await insertEvents(tx, [{ orderId, type: 'note', actorType: 'staff', actorId: staff.staffId, data: { body } }]);
      const merchant = order.clientId === null ? undefined : await merchantOf(tx, order.clientId);
      await this.audit.record(tx, {
        action: ORDER_AUDIT_ACTIONS.note,
        entityType: 'order',
        entityId: orderId,
        entityLabel: merchant ? `ORD-${orderId} for ${merchant.name}` : `ORD-${orderId}`,
        before: { adminNote: order.adminNote },
        after: { adminNote: body },
      });
    });
  }

  private async run(
    staff: StaffActor,
    orderId: number,
    action: Parameters<OrderTransitions['apply']>[1]['action'],
    audit: string,
    texts: {
      reason?: string | undefined;
      code?: string | undefined;
      comment?: string | undefined;
      note?: string | undefined;
    },
  ): Promise<void> {
    await this.db.runInTransaction(({ tx }) =>
      this.transitions.apply(tx, {
        orderId,
        action,
        actor: { type: 'staff', id: staff.staffId },
        audit,
        ...texts,
      }),
    );
  }
}

/** The system as an event actor, re-exported for the jobs that act on orders. */
export { SYSTEM_ACTOR };
