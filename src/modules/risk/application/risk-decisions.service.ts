// RiskDecisionsService: the staff decision on a held order (POST /admin/risk/orders/:id/approve and /refund, map domain K, stage 18,
// RESOLUTIONS orders-suppliers-11, decision 025): release it to dispatch, or refund it and optionally block the buyer.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { OrderTransitions, placementDispatchState } from '../../orders';
import { AuditService } from '../../platform';
import { auditBlockLabel } from '../domain/blocklist-values';
import { refundReason, signalsOf } from '../domain/queue-view';
import { markDecided } from '../infra/assessment.repository';
import { type HeldOrderContext, lockHeldContext, serviceDispatchFacts } from '../infra/foreign-reads.repository';
import { Blocklist, type BlockRequest } from './blocklist';

/** What `POST /admin/risk/orders/:id/refund` carries. */
export interface RefundHeldInput {
  /** The reviewer's reason; blank means the default sentence made from the first signal. */
  readonly reason?: string | undefined;
  /** Add the customer's email to the blocklist. */
  readonly blockEmail: boolean;
  /** Add the order's IMEI (the device) to the blocklist. */
  readonly blockDevice: boolean;
}

/**
 * Decides held orders.
 *
 * Why: orders-suppliers-11 and decision 025: a held order waits for a person. Approve releases it by the placement rule (to the
 * dispatch job, or to the manual queue for a manual service or one without an active supplier link); refund rejects it without
 * contacting a supplier and returns the money (the machine's `b2c_refund` ledger move), then adds the chosen blocklist entries.
 * Both run in one transaction: the assessment row is locked first (a second staff member waits and then finds it decided, `409
 * NOT_HELD`), then the order moves through `OrderTransitions` (the guarded update, the ledger, the timeline lines, the outbox),
 * then the assessment records who decided and how. The customer's status is not changed: blocking the customer stays
 * `POST /admin/customers/:id/block` (B77). The refunds row and the gateway refund of a storefront payment are feature 16's, hooked
 * into the machine's `b2c_refund` move like a staff rejection: the whole payment goes back through `B2cRefunds` (one `refunds` row
 * requested by the staff member, one `b2c_refund` journal, one `refund.process` event), never a second journal or refund.
 * {@link RiskDecisionsService.refundBlocked} is the same refund done by the system for a payment the rules blocked at capture.
 *
 * Side effects: updates `orders`, `risk_assessments`; inserts `order_events`, ledger rows (refund), `refunds`, `outbox_events` (the
 * dispatch request on approve, the status change and the gateway refund on refund), `blocklist_entries` (staff refund) and
 * `audit_logs` (staff decisions only: the system writes no audit row).
 */
@Injectable()
export class RiskDecisionsService {
  constructor(
    private readonly db: DbService,
    private readonly transitions: OrderTransitions,
    private readonly blocklist: Blocklist,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Approves a held order.
   *
   * @param staffId the signed-in staff member
   * @param orderId the order id (not the assessment id)
   * @throws {AppError} `NOT_FOUND` (404: no such storefront order or no assessment), `NOT_HELD` (409: already decided, refunded
   *   elsewhere, or never held)
   */
  async approve(staffId: number, orderId: number): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      const held = await this.lockHeld(tx, orderId);
      const facts = await serviceDispatchFacts(tx, held.serviceId);
      const manual =
        placementDispatchState({
          held: false,
          deliveredFromInventory: false,
          manualService: facts.manualService,
          hasActiveSupplierLink: facts.hasActiveSupplierLink,
        }).dispatchState === 'manual';
      await this.transitions.apply(tx, {
        orderId,
        action: { kind: 'riskApprove', manual },
        actor: { type: 'staff', id: staffId },
      });
      await markDecided(tx, held.assessmentId, { reviewedBy: staffId, reviewedAt: now, outcome: 'approved' });
      await this.audit.record(tx, {
        action: 'approved after risk review',
        entityType: 'order',
        entityId: orderId,
        entityLabel: `ORD-${orderId} for ${held.customerName}`,
        before: { risk_decision: 'review' },
        after: { risk_decision: 'approved' },
      });
    });
  }

  /**
   * Refunds a held order and optionally blocks the buyer.
   *
   * @param staffId the signed-in staff member
   * @param orderId the order id
   * @param input the reason and the two blocklist switches
   * @throws {AppError} `NOT_FOUND` (404), `NOT_HELD` (409)
   */
  async refund(staffId: number, orderId: number, input: RefundHeldInput): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      const held = await this.lockHeld(tx, orderId);
      const reason = refundReason(signalsOf(held.signals), input.reason);
      await this.rejectAndRefund(tx, held.assessmentId, orderId, { type: 'staff', id: staffId }, reason, now);
      const blocked = await this.addBlocks(tx, held, input, staffId, reason);
      await this.audit.record(tx, {
        action: 'refunded after risk review',
        entityType: 'order',
        entityId: orderId,
        entityLabel: `ORD-${orderId} for ${held.customerName}`,
        before: { risk_decision: 'review' },
        // The audit row keeps no readable IMEI: it names the kind and the masked display (the blocklist page has the rest).
        after: { risk_decision: 'refunded', reason, ...(blocked.length > 0 ? { blocked } : {}) },
      });
    });
  }

  /**
   * Refunds, as the system, an order the rules blocked at capture.
   *
   * Why: RESOLUTIONS orders-suppliers-11 and RULES risk: a payment the rules block is never worked. The checkout places the order
   * `held` (the machine only refunds a held order) and this rejects it at once, with the same refund a staff decision gives: the whole
   * payment goes back through `B2cRefunds` (a `processing` refund, the `b2c_refund` journal and the `refund.process` event). There is no
   * staff actor, the reason is the first signal, no blocklist entry is added and no audit row is written (the system acts).
   *
   * @param tx the capture's transaction
   * @param input the order just placed, its assessment (decision `block`) and the assessment's signals
   * @throws {AppError} whatever the machine refuses (`INVALID_TRANSITION` when the order is not held)
   */
  async refundBlocked(
    tx: DbExecutor,
    input: { readonly orderId: number; readonly assessmentId: number; readonly signals: readonly string[] },
  ): Promise<void> {
    const reason = refundReason(input.signals, undefined);
    await this.rejectAndRefund(
      tx,
      input.assessmentId,
      input.orderId,
      { type: 'system', id: null },
      reason,
      this.clock.now(),
    );
  }

  /** The move both refunds share: the machine rejects the held order and refunds it, then the assessment records who decided. */
  private async rejectAndRefund(
    tx: DbExecutor,
    assessmentId: number,
    orderId: number,
    actor: { readonly type: 'staff' | 'system'; readonly id: number | null },
    reason: string,
    now: Date,
  ): Promise<void> {
    await this.transitions.apply(tx, { orderId, action: { kind: 'riskRefund' }, actor, reason });
    await markDecided(tx, assessmentId, { reviewedBy: actor.id, reviewedAt: now, outcome: 'refunded' });
  }

  /** Locks the newest assessment and checks that its order is still waiting for a decision. */
  private async lockHeld(tx: DbExecutor, orderId: number): Promise<HeldOrderContext> {
    const held = await lockHeldContext(tx, orderId);
    if (!held) throw new AppError('NOT_FOUND', { detail: 'No storefront order with a risk assessment has this id.' });
    if (held.dispatchState !== 'held' || held.decision !== 'review' || held.reviewedAt !== null) {
      throw new AppError('NOT_HELD', { detail: `ORD-${orderId} is not held for risk review any more.` });
    }
    return held;
  }

  /**
   * Adds the entries the reviewer chose. They are manual entries of the reviewer and keep `customer_id` empty: only the customer's
   * own block links entries to a customer (RESOLUTIONS b2c-5). A value that is already blocked is skipped silently.
   */
  private async addBlocks(
    tx: DbExecutor,
    held: HeldOrderContext,
    input: RefundHeldInput,
    staffId: number,
    reason: string,
  ): Promise<string[]> {
    const requests: BlockRequest[] = [];
    if (input.blockEmail) {
      requests.push({ kind: 'email', value: held.customerEmail, reason, source: 'manual', createdBy: staffId });
    }
    const imei = (held.imei ?? '').replace(/[\s-]/g, '');
    if (input.blockDevice && /^\d{15}$/.test(imei)) {
      requests.push({ kind: 'imei', value: imei, reason, source: 'manual', createdBy: staffId });
    }
    const added = await this.blocklist.add(tx, requests);
    return added.map((entry) => auditBlockLabel(entry));
  }
}
