// Unit tests of who earns a commission and how an approval splits its ids (feature 11, RULES commissions 1 to 3).
import { describe, expect, it } from 'bun:test';
import { type ApprovalCandidate, type CurrentPlan, SKIP_REASONS, accruingPlans, planApproval } from './accrual-rules';

const referral = (beneficiaryId: number, over: Partial<CurrentPlan> = {}): CurrentPlan => ({
  beneficiaryId,
  planId: 1,
  kind: 'referral',
  percent: '3.0000',
  isActive: true,
  ...over,
});
const rebate = (beneficiaryId: number, over: Partial<CurrentPlan> = {}): CurrentPlan => ({
  beneficiaryId,
  planId: 2,
  kind: 'rebate',
  percent: '1.5000',
  isActive: true,
  ...over,
});

describe('accruingPlans', () => {
  it("pays the referrer's referral plan on a referred merchant's order", () => {
    expect(accruingPlans(8, 1, [referral(1)]).map((plan) => plan.beneficiaryId)).toEqual([1]);
  });

  it("pays the order's own merchant a rebate on its own order", () => {
    expect(accruingPlans(8, null, [rebate(8)]).map((plan) => plan.beneficiaryId)).toEqual([8]);
  });

  it('pays both when the merchant has a rebate and its referrer a referral plan', () => {
    expect(accruingPlans(8, 1, [referral(1), rebate(8)]).map((plan) => [plan.beneficiaryId, plan.kind])).toEqual([
      [8, 'rebate'],
      [1, 'referral'],
    ]);
  });

  it("does not pay a referral plan on the agent's own order, nor a rebate plan on referred merchants' orders", () => {
    expect(accruingPlans(1, null, [referral(1)])).toEqual([]);
    expect(accruingPlans(8, 1, [rebate(1)])).toEqual([]);
  });

  it('pays nothing for a plan that is switched off or when nobody is on a plan', () => {
    expect(accruingPlans(8, 1, [referral(1, { isActive: false })])).toEqual([]);
    expect(accruingPlans(8, 1, [])).toEqual([]);
  });

  it('never pays a merchant that referred itself a referral commission on its own order', () => {
    expect(accruingPlans(8, 8, [referral(8)])).toEqual([]);
  });
});

const row = (
  id: number,
  beneficiaryId: number,
  amount: string,
  status: ApprovalCandidate['status'] = 'accrued',
): ApprovalCandidate => ({ id, beneficiaryId, amount, status });

describe('planApproval', () => {
  it('groups the ready accruals by agent, in agent order, with ascending ids and the exact sum', () => {
    const found = new Map([row(5, 2, '0.3500'), row(3, 1, '0.1700'), row(4, 1, '0.4900')].map((r) => [r.id, r]));
    const { batches, skipped } = planApproval([5, 4, 3], found);
    expect(skipped).toEqual([]);
    expect(batches.map((batch) => [batch.beneficiaryId, batch.accrualIds, batch.total.toWire()])).toEqual([
      [1, [3, 4], '0.6600'],
      [2, [5], '0.3500'],
    ]);
  });

  it('skips unknown, approved and reversed accruals with their reasons, in request order, and pays the rest', () => {
    const found = new Map(
      [row(1, 1, '1.0000'), row(2, 1, '2.0000', 'approved'), row(3, 1, '3.0000', 'reversed')].map((r) => [r.id, r]),
    );
    const { batches, skipped } = planApproval([3, 99, 2, 1], found);
    expect(skipped).toEqual([
      { id: 3, reason: SKIP_REASONS.reversed },
      { id: 99, reason: SKIP_REASONS.missing },
      { id: 2, reason: SKIP_REASONS.approved },
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.total.toWire()).toBe('1.0000');
  });

  it('skips an accrual of 0 and pays the others of the same agent, as if the zero row were not there', () => {
    const found = new Map([row(1, 1, '0.0000'), row(2, 1, '1.2500'), row(3, 2, '0.0000')].map((r) => [r.id, r]));
    const { batches, skipped } = planApproval([1, 2, 3], found);
    expect(skipped).toEqual([
      { id: 1, reason: SKIP_REASONS.zero },
      { id: 3, reason: SKIP_REASONS.zero },
    ]);
    // Agent 2 has nothing left to pay, so it gets no batch (and no posting).
    expect(batches.map((batch) => [batch.beneficiaryId, batch.accrualIds, batch.total.toWire()])).toEqual([
      [1, [2], '1.2500'],
    ]);
  });

  it('names a reversed or approved row of 0 by its status, not as a zero row', () => {
    const found = new Map([row(1, 1, '0.0000', 'reversed'), row(2, 1, '0.0000', 'approved')].map((r) => [r.id, r]));
    expect(planApproval([1, 2], found).skipped).toEqual([
      { id: 1, reason: SKIP_REASONS.reversed },
      { id: 2, reason: SKIP_REASONS.approved },
    ]);
  });

  it('uses the sentences of RULES commissions 3', () => {
    expect(SKIP_REASONS).toEqual({
      missing: 'This accrual does not exist.',
      approved: 'Already approved.',
      reversed: 'Reversed: the order was refunded or reopened.',
      zero: 'Nothing to pay: the amount is 0.',
    });
  });

  it('reads a repeated id once', () => {
    const found = new Map([[1, row(1, 1, '1.0000')]]);
    const { batches } = planApproval([1, 1, 1], found);
    expect(batches[0]!.accrualIds).toEqual([1]);
    expect(batches[0]!.total.toWire()).toBe('1.0000');
  });

  it('answers nothing to pay for an empty set of rows', () => {
    expect(planApproval([7], new Map())).toEqual({ batches: [], skipped: [{ id: 7, reason: SKIP_REASONS.missing }] });
  });
});
