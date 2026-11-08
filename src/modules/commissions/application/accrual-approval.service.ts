// AccrualApproval: `POST /admin/commission-accruals/approve` (stage 11): pays the ready accruals into the agents' wallets with one
// `commission` posting per agent and marks them approved, in one transaction (RULES commissions 2 and 3, resolution health-commissions-4,
// ANSWERS commissions Q1 and Q7, MISMATCHES B43).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { BASE_CURRENCY, LedgerPoster, commission } from '../../money';
import { AuditService } from '../../platform';
import { type SkippedAccrual, planApproval } from '../domain/accrual-rules';
import { moneyText } from '../domain/commission-math';
import { lockAccruals, markApproved } from '../infra/accrual.repository';
import { findMerchants } from '../infra/foreign-reads.repository';

/** What an approval answers: how many accruals it paid, the money it posted, and the ones it skipped with the reason. */
export interface ApprovalResult {
  readonly approved: number;
  /** The money actually posted, 4 decimals. */
  readonly total: string;
  readonly skipped: SkippedAccrual[];
}

/**
 * Approves commissions in bulk.
 *
 * Why: RULES commissions 2 and 3. The accruals are locked in id order; an unknown id and an accrual that is not `accrued` (approved
 * before, or reversed because its order was refunded or reopened) are skipped with their reason, never failed; so is an accrual of 0
 * (the engine never writes one, but a hand-written or seeded row must not make the ledger refuse the whole request): it stays
 * `accrued`. The rest is grouped by
 * agent and each agent gets one `commission` posting for the sum (Dr `commission_expense` / Cr the agent's `client_wallet`, ref type
 * `accrual`, ref id the agent's lowest accrual id, memo `Commission batch, N accruals to <agent>`), with the key
 * `commission:<agent>:<lowest accrual id>`: an accrual is approved once, so the key is unique to its batch and a replay posts nothing.
 * Each accrual gets `status approved`, the posting's `ledger_tx_id` and `approved_at` from the clock. The whole request is one
 * transaction: a failing posting leaves every accrual as it was. One audit row per agent paid (the demo's `approved commissions for`);
 * a request that paid nobody writes one row saying so, so the request is audited either way.
 *
 * Side effects: updates `commission_accruals`; inserts `ledger_transactions` and entries and changes balances through `LedgerPoster`
 * (which also writes `wallet.low_balance` outbox events when a wallet crosses its alert); inserts `audit_logs`.
 */
@Injectable()
export class AccrualApproval {
  constructor(
    private readonly db: DbService,
    private readonly poster: LedgerPoster,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Approves the given accruals.
   *
   * @param staffId the staff member approving (the ledger and the audit log record them)
   * @param ids the accrual ids (1 to 1000, checked by the contract; repeats are read once)
   * @returns the count approved, the money posted and the skipped accruals
   * @throws {AppError} `INSUFFICIENT_FUNDS` is impossible here (a credit always passes); a database failure rolls everything back
   */
  async approve(staffId: number, ids: readonly number[]): Promise<ApprovalResult> {
    return this.db.runInTransaction(async ({ tx }) => {
      const found = await lockAccruals(tx, ids);
      const { batches, skipped } = planApproval(ids, found);
      const agents = await findMerchants(
        tx,
        batches.map((batch) => batch.beneficiaryId),
      );
      const now = this.clock.now();
      let total = Money.zero();
      let approved = 0;
      for (const batch of batches) {
        const firstId = batch.accrualIds[0]!;
        const agentName = agents.get(batch.beneficiaryId)?.name ?? `Merchant ${batch.beneficiaryId}`;
        const count = batch.accrualIds.length;
        const posted = await this.poster.post(tx, {
          ...commission({ clientId: batch.beneficiaryId, amount: batch.total }),
          refId: firstId,
          idempotencyKey: `commission:${batch.beneficiaryId}:${firstId}`,
          currency: BASE_CURRENCY,
          memo: `Commission batch, ${count} accrual${count === 1 ? '' : 's'} to ${agentName}`,
          createdBy: { type: 'staff', id: staffId },
        });
        await markApproved(tx, batch.accrualIds, posted.id, now);
        total = total.add(batch.total);
        approved += count;
        await this.audit.record(tx, {
          action: 'approved commissions for',
          entityType: 'merchant',
          entityId: batch.beneficiaryId,
          entityLabel: `${agentName}, ${count} accrual${count === 1 ? '' : 's'}, ${moneyText(batch.total)}`,
          before: { status: 'accrued' },
          after: {
            status: 'approved',
            accrualIds: [...batch.accrualIds],
            amount: batch.total.toWire(),
            ledgerTxId: posted.id,
          },
        });
      }
      if (batches.length === 0) {
        await this.audit.record(tx, {
          action: 'approved commissions for',
          entityType: 'merchant',
          entityLabel: `no agents (${skipped.length} accrual${skipped.length === 1 ? '' : 's'} skipped)`,
          after: { approved: 0, skipped: skipped.map((item) => item.id) },
        });
      }
      return { approved, total: total.toWire(), skipped };
    });
  }
}
