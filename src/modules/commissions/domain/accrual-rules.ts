// Who earns a commission when an order completes, and how a bulk approval splits the accruals it was given.
// Rules: RULES commissions 1 to 3, resolution health-commissions-3 and -4 (feature 11). Pure functions, unit-tested.
import { Money } from '../../../common/money';
import type { CommissionAccrualStatus, CommissionPlanKind } from '../db/schema';

/** A merchant's current plan, as the accrual rule needs it. */
export interface CurrentPlan {
  readonly beneficiaryId: number;
  readonly planId: number;
  readonly kind: CommissionPlanKind;
  /** The plan's rate as stored (`3.0000`). */
  readonly percent: string;
  readonly isActive: boolean;
}

/**
 * Picks the plans that pay a commission for one completed order.
 *
 * Why: RULES commissions 1: a `referral` plan pays the merchant in `clients.referred_by_id` of the order's merchant, a `rebate` plan
 * pays the order's own merchant. A plan that is switched off pays nothing. A merchant that referred itself earns no referral
 * commission on its own order, and a merchant cannot earn both kinds on one order (each beneficiary has one current plan).
 *
 * @param clientId the order's merchant
 * @param referrerId the merchant that referred it, or `null`
 * @param current the current plans of those two merchants (one each at most)
 * @returns the plans that accrue, the rebate of the merchant first
 */
export function accruingPlans(
  clientId: number,
  referrerId: number | null,
  current: readonly CurrentPlan[],
): CurrentPlan[] {
  const picked: CurrentPlan[] = [];
  const own = current.find((plan) => plan.beneficiaryId === clientId);
  if (own && own.kind === 'rebate' && own.isActive) picked.push(own);
  if (referrerId !== null && referrerId !== clientId) {
    const referral = current.find((plan) => plan.beneficiaryId === referrerId);
    if (referral && referral.kind === 'referral' && referral.isActive) picked.push(referral);
  }
  return picked;
}

/**
 * The sentences a skipped accrual of an approval carries (RULES commissions 3). `zero` is the one the rules do not list: the engine
 * never writes an accrual of 0, but a hand-written or seeded one must not stop the others from being paid.
 */
export const SKIP_REASONS = {
  missing: 'This accrual does not exist.',
  approved: 'Already approved.',
  reversed: 'Reversed: the order was refunded or reopened.',
  zero: 'Nothing to pay: the amount is 0.',
} as const;

/** What the approval needs to know about a stored accrual. */
export interface ApprovalCandidate {
  readonly id: number;
  readonly beneficiaryId: number;
  readonly amount: string;
  readonly status: CommissionAccrualStatus;
}

/** The accruals of one agent that an approval pays together. */
export interface ApprovalBatch {
  readonly beneficiaryId: number;
  /** The accrual ids, ascending. */
  readonly accrualIds: readonly number[];
  readonly total: Money;
}

/** An accrual an approval did not pay, with the sentence the console prints. */
export interface SkippedAccrual {
  readonly id: number;
  readonly reason: string;
}

/**
 * Splits the ids of an approval into one batch per agent and the accruals it skips.
 *
 * Why: RULES commissions 2 and 3: unknown ids and accruals that are not `accrued` are skipped with a reason, never failed; the rest
 * is paid with one posting per agent for the sum of its accruals. An `accrued` row whose amount is 0 is skipped too and stays
 * `accrued`: the ledger refuses a posting of 0 (`LEDGER_UNBALANCED`), which would fail the whole request for one empty row. Batches come in agent id order and each batch's ids ascend, so
 * the postings lock the wallets in the same order every time.
 *
 * @param ids the requested ids (repeats are read once, in first-seen order)
 * @param found the stored accruals among them
 * @returns the batches to pay and the skipped accruals in request order
 */
export function planApproval(
  ids: readonly number[],
  found: ReadonlyMap<number, ApprovalCandidate>,
): { batches: ApprovalBatch[]; skipped: SkippedAccrual[] } {
  const skipped: SkippedAccrual[] = [];
  const byAgent = new Map<number, ApprovalCandidate[]>();
  for (const id of new Set(ids)) {
    const row = found.get(id);
    if (!row) skipped.push({ id, reason: SKIP_REASONS.missing });
    else if (row.status === 'approved') skipped.push({ id, reason: SKIP_REASONS.approved });
    else if (row.status === 'reversed') skipped.push({ id, reason: SKIP_REASONS.reversed });
    else if (!Money.of(row.amount).isPositive()) skipped.push({ id, reason: SKIP_REASONS.zero });
    else byAgent.set(row.beneficiaryId, [...(byAgent.get(row.beneficiaryId) ?? []), row]);
  }
  const batches = [...byAgent.entries()]
    .sort(([a], [b]) => a - b)
    .map(([beneficiaryId, rows]) => ({
      beneficiaryId,
      accrualIds: rows.map((row) => row.id).sort((a, b) => a - b),
      total: Money.sum(rows.map((row) => Money.of(row.amount))),
    }));
  return { batches, skipped };
}
