// GroupPromotion: the nightly job that promotes merchants to a higher merchant group by their completed-order spend
// (identity module, queue maintenance, job client_group_promotion; user rule 1, ANSWERS merchants Q7).
import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { ClientGroupDirectory, type ClientGroupRef } from '../../catalog';
import { MerchantSpend, MerchantWallets } from '../../money';
import { AuditService } from '../../platform';
import { SessionService } from '../security/session.service';
import { clients } from '../db/schema';
import { type PromotionTarget, breaksCreditRule, decidePromotion } from '../domain/group-promotion';
import { lockClient, updateClientRow } from '../infra/client-admin.repository';

/** Merchants read per round. */
export const PROMOTION_BATCH_SIZE = 500;

/** What one run did. */
export interface PromotionSummary {
  /** Merchants whose spend and group were looked at. */
  readonly checked: number;
  /** Merchants moved to a higher group. */
  readonly promoted: number;
  /** Promotions the credit rule (ip-3) or a concurrent change stopped; they are logged and tried again the next night. */
  readonly skipped: number;
}

const toTarget = (group: ClientGroupRef): PromotionTarget => ({
  id: group.id,
  earnThreshold: Money.of(group.earnThreshold),
  overdraftAllowed: group.overdraftAllowed,
});

/**
 * Promotes merchants by cumulative completed-order spend.
 *
 * Why: user rule 1 (ANSWERS merchants Q7): a merchant moves up, never down, to the merchant group with the highest `earn_threshold`
 * above zero that its spend in USD since account creation reaches and that is above its current group's threshold; the
 * storefront retail group is never a target; staff may change a group by hand at any time (`PATCH /admin/clients/:id`). The
 * ledger is the source of truth for the spend (`MerchantSpend`). Only `active` merchants are looked at: a pending merchant has no
 * orders, and a suspended one is picked up after it is reactivated.
 *
 * Idempotent: each promotion is one transaction that locks the merchant row, re-reads its group and checks the credit rule
 * (ip-3: a target without overdraft is skipped while the merchant has a credit limit), so a repeat or a parallel run never
 * promotes a merchant twice and never overrides a move staff made meanwhile; a merchant already in the target group is not a
 * candidate. Merchants are read by id in batches, so a long run never holds a long transaction.
 *
 * Side effects: updates `clients.group_id`; writes one `audit_logs` row per promoted merchant (no request, so the actor is
 * `system`); clears the cached session views of the promoted merchant (`SessionService.invalidateSubject`).
 *
 * @see docs/queues.md (`client_group_promotion`)
 */
@Injectable()
export class GroupPromotion {
  private readonly logger = new Logger(GroupPromotion.name);

  constructor(
    private readonly db: DbService,
    private readonly groups: ClientGroupDirectory,
    private readonly spend: MerchantSpend,
    private readonly wallets: MerchantWallets,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Runs the promotion over every active merchant.
   *
   * @returns how many merchants were checked, promoted and skipped
   */
  async run(): Promise<PromotionSummary> {
    const ladder = await this.groups.promotionLadder(this.db.db);
    const lowest = ladder.at(-1);
    if (!lowest) return { checked: 0, promoted: 0, skipped: 0 };
    const lowestThreshold = Money.of(lowest.earnThreshold);
    const targets = ladder.map(toTarget);

    let checked = 0;
    let promoted = 0;
    let skipped = 0;
    let after = 0;
    for (;;) {
      const batch = await this.db.db
        .select({ id: clients.id, groupId: clients.groupId })
        .from(clients)
        .where(and(eq(clients.status, 'active'), gt(clients.id, after)))
        .orderBy(asc(clients.id))
        .limit(PROMOTION_BATCH_SIZE);
      if (batch.length === 0) break;
      after = batch.at(-1)!.id;
      checked += batch.length;

      const spent = await this.spend.completedSpend(
        this.db.db,
        batch.map((client) => client.id),
      );
      const current = await this.groups.refsOf(
        this.db.db,
        batch.map((client) => client.groupId),
      );
      for (const client of batch) {
        const total = spent.get(client.id) ?? Money.zero();
        // Below the lowest threshold nothing can be earned: the common case needs no further work.
        if (total.cmp(lowestThreshold) < 0) continue;
        const group = current.get(client.groupId);
        if (!group) continue;
        const target = decidePromotion(total, { id: group.id, earnThreshold: Money.of(group.earnThreshold) }, targets);
        if (!target) continue;
        if (await this.promote(client.id, client.groupId, target.id, total)) promoted += 1;
        else skipped += 1;
      }
      if (batch.length < PROMOTION_BATCH_SIZE) break;
    }
    return { checked, promoted, skipped };
  }

  /** Moves one merchant, in its own transaction; false when the move was skipped. */
  private async promote(clientId: number, fromGroupId: number, toGroupId: number, spend: Money): Promise<boolean> {
    return this.db.runInTransaction(async (work) => {
      const client = await lockClient(work.tx, clientId);
      // Staff moved the merchant (or it was removed) since the batch was read: leave it for the next night.
      if (!client || client.groupId !== fromGroupId || client.status !== 'active') return false;
      const [from, target] = await Promise.all([
        this.groups.find(work.tx, fromGroupId),
        this.groups.find(work.tx, toGroupId, { lock: 'share' }),
      ]);
      if (!from || !target) return false;
      // The thresholds may have been edited since the ladder was read: decide again on what is stored now.
      const decided = decidePromotion(spend, { id: from.id, earnThreshold: Money.of(from.earnThreshold) }, [
        toTarget(target),
      ]);
      if (target.kind !== 'b2b' || decided === undefined) return false;
      if (breaksCreditRule(target, await this.wallets.creditLimitOf(work.tx, clientId))) {
        this.logger.warn(
          `Merchant ${clientId} reached group ${target.id} but has a credit limit and the group does not allow overdraft: not promoted`,
        );
        return false;
      }
      await updateClientRow(work.tx, clientId, { groupId: target.id });
      await this.audit.record(work.tx, {
        // The demo's phrase for a group move (ANSWERS audit Q3); the actor is the system and `after` names the new group.
        action: 'changed group of',
        entityType: 'merchant',
        entityId: clientId,
        entityLabel: client.name,
        before: { groupId: from.id, group: from.name },
        after: { groupId: target.id, group: target.name, spend: spend.toWire(), earnThreshold: target.earnThreshold },
      });
      await this.sessions.invalidateSubject('client', clientId, work);
      return true;
    });
  }
}
