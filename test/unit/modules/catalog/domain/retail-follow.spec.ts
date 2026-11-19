// Unit tests of the follow pass's rules (decision 040, plan 31 sections 3.4 and 8.1): the table row by row and in its order, the reason of
// a price written at once, the service that moved by itself, what makes a proposal change, and what an approval may do.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  type FollowDecision,
  type FollowFacts,
  type WaitingProposal,
  approvedFigure,
  decideFollow,
  followHasWork,
  followRowIsBehind,
  judgeApproval,
  proposalDiffers,
} from '@src/modules/catalog/domain/retail-follow';

const m = (value: string) => Money.of(value);
const APPLIED_AT = new Date('2026-11-18T09:00:00.000Z');
const BEFORE = new Date('2026-11-18T08:00:00.000Z');
const AFTER = new Date('2026-11-18T10:00:00.000Z');

/** Cost 10, stored 13.99, the same rule gives 13.99: nothing to do. */
const facts = (over: Partial<FollowFacts> = {}): FollowFacts => ({
  stored: m('13.99'),
  cost: m('10'),
  follow: { ruleId: 1, appliedPrice: m('13.99'), appliedCost: m('10'), appliedAt: APPLIED_AT },
  rule: { id: 1, autoFollowPercent: 25, changedAt: BEFORE },
  rulePrice: { kind: 'price', price: m('13.99'), raw: m('13'), atFloor: false },
  followedRule: { isActive: true, deletedAt: null, changedAt: BEFORE },
  ...over,
});
const priced = (price: string) => ({ kind: 'price', price: m(price), raw: m(price), atFloor: false }) as const;
const proposal = (over: Partial<WaitingProposal> = {}): WaitingProposal => ({
  reason: 'cost_jump',
  ruleId: 1,
  newPrice: m('26.99'),
  newCost: m('20'),
  ...over,
});

describe('decideFollow: the table of plan 31 section 3.4, in its order', () => {
  it('drops a price with no retail row', () => {
    expect(decideFollow(facts({ stored: null }))).toEqual({ kind: 'drop' });
  });

  it('detaches a stored price that is not the one last written, before anything else is looked at', () => {
    expect(decideFollow(facts({ stored: m('13.98'), rule: null, rulePrice: null }))).toEqual({ kind: 'detach' });
    expect(decideFollow(facts({ stored: m('20'), cost: m('0'), rulePrice: { kind: 'no_cost' } }))).toEqual({
      kind: 'detach',
    });
  });

  it('leaves the price alone when no active rule covers the service', () => {
    expect(decideFollow(facts({ rule: null, rulePrice: null, cost: m('50') }))).toEqual({ kind: 'leave' });
  });

  it('settles when the rule gives the stored price, whatever the cost did', () => {
    expect(decideFollow(facts({ cost: m('100') }))).toEqual({ kind: 'settle', ruleId: 1 });
  });

  it('proposes no_cost for a cost of 0, with no price', () => {
    expect(decideFollow(facts({ cost: m('0'), rulePrice: { kind: 'no_cost' } }))).toEqual({
      kind: 'propose',
      reason: 'no_cost',
      ruleId: 1,
      price: null,
    });
  });

  it('proposes cost_jump above the limit, up and down, and follows exactly at the limit', () => {
    const jump = (cost: string) => decideFollow(facts({ cost: m(cost), rulePrice: priced('50') }));
    expect(jump('12.5001')).toMatchObject({ kind: 'propose', reason: 'cost_jump', price: m('50') });
    expect(jump('7.4999')).toMatchObject({ kind: 'propose', reason: 'cost_jump' });
    expect(jump('12.5')).toMatchObject({ kind: 'write', reason: 'cost_changed', price: m('50') });
    expect(jump('7.5')).toMatchObject({ kind: 'write', reason: 'cost_changed' });
  });

  it('a limit of 0 makes every move of the cost wait, and an applied cost of 0 makes any cost a jump', () => {
    const rule = { id: 1, autoFollowPercent: 0, changedAt: BEFORE };
    expect(decideFollow(facts({ rule, cost: m('10.0001'), rulePrice: priced('50') }))).toMatchObject({
      kind: 'propose',
      reason: 'cost_jump',
    });
    const follow = { ruleId: 1, appliedPrice: m('13.99'), appliedCost: m('0'), appliedAt: APPLIED_AT };
    expect(decideFollow(facts({ follow, cost: m('1'), rulePrice: priced('50') }))).toMatchObject({
      kind: 'propose',
      reason: 'cost_jump',
    });
  });

  it('writes at once inside the limit', () => {
    expect(decideFollow(facts({ cost: m('11'), rulePrice: priced('14.99') }))).toEqual({
      kind: 'write',
      reason: 'cost_changed',
      ruleId: 1,
      price: m('14.99'),
    });
  });
});

describe('decideFollow: the reason of a price written at once', () => {
  const write = (over: Partial<FollowFacts>) => decideFollow(facts({ rulePrice: priced('15.99'), ...over }));

  it('is cost_changed when the cost differs, even when the rule changed too', () => {
    expect(write({ cost: m('11'), rule: { id: 1, autoFollowPercent: 25, changedAt: AFTER } })).toMatchObject({
      reason: 'cost_changed',
    });
  });

  it('is rule_changed when the rule was edited after the price was applied', () => {
    expect(write({ rule: { id: 1, autoFollowPercent: 25, changedAt: AFTER } })).toMatchObject({
      kind: 'write',
      reason: 'rule_changed',
    });
  });

  it('is rule_changed when another rule prices the service and the old one was switched off, edited or deleted', () => {
    const rule = { id: 2, autoFollowPercent: 25, changedAt: BEFORE };
    for (const followedRule of [
      { isActive: false, deletedAt: null, changedAt: BEFORE },
      { isActive: false, deletedAt: AFTER, changedAt: AFTER },
      { isActive: true, deletedAt: null, changedAt: AFTER },
    ]) {
      expect(write({ rule, followedRule })).toMatchObject({ kind: 'write', reason: 'rule_changed', ruleId: 2 });
    }
  });

  it('is floor_changed when only the floor can have moved', () => {
    expect(write({})).toMatchObject({ kind: 'write', reason: 'floor_changed' });
  });

  it('treats a follow row without a rule (the cascade of a category delete) as "the rule changed", never as an error', () => {
    const follow = { ruleId: null, appliedPrice: m('13.99'), appliedCost: m('10'), appliedAt: APPLIED_AT };
    expect(write({ follow, followedRule: null })).toMatchObject({ kind: 'write', reason: 'rule_changed', ruleId: 1 });
    expect(write({ follow, followedRule: null, cost: m('11') })).toMatchObject({ reason: 'cost_changed' });
  });
});

describe('decideFollow: a service that came under another rule by itself (plan correction 3)', () => {
  const moved = (over: Partial<FollowFacts> = {}) =>
    decideFollow(
      facts({ rule: { id: 2, autoFollowPercent: 25, changedAt: BEFORE }, rulePrice: priced('15.99'), ...over }),
    );

  it('proposes rule_changed when the old rule still stands and the new one is no newer than the price', () => {
    expect(moved()).toEqual({ kind: 'propose', reason: 'rule_changed', ruleId: 2, price: m('15.99') });
  });

  it('counts a rule changed at the very moment the price was applied as unchanged', () => {
    expect(moved({ rule: { id: 2, autoFollowPercent: 25, changedAt: APPLIED_AT } })).toMatchObject({ kind: 'propose' });
  });

  it('applies at once when the rule of now was created or edited after the price: that is a decision of staff', () => {
    expect(moved({ rule: { id: 2, autoFollowPercent: 25, changedAt: AFTER } })).toMatchObject({
      kind: 'write',
      reason: 'rule_changed',
    });
  });

  it('a cost over the limit comes first', () => {
    expect(moved({ cost: m('20') })).toMatchObject({ kind: 'propose', reason: 'cost_jump' });
  });

  it('settles when the new rule gives the stored price', () => {
    expect(moved({ rulePrice: priced('13.99') })).toEqual({ kind: 'settle', ruleId: 2 });
  });
});

describe('followRowIsBehind', () => {
  it('is false for a row that says everything', () => {
    expect(followRowIsBehind({ ruleId: 1 }, facts())).toBe(false);
  });

  it('is true for a new cost, another rule, and a rule edited since', () => {
    expect(followRowIsBehind({ ruleId: 1 }, facts({ cost: m('11') }))).toBe(true);
    expect(followRowIsBehind({ ruleId: 2 }, facts())).toBe(true);
    expect(followRowIsBehind({ ruleId: 1 }, facts({ rule: { id: 1, autoFollowPercent: 25, changedAt: AFTER } }))).toBe(
      true,
    );
  });
});

describe('proposalDiffers', () => {
  const same = { reason: 'cost_jump', ruleId: 1, price: m('26.99') } as const;

  it('is false when everything it shows is the same', () => {
    expect(proposalDiffers(proposal(), same, m('20'))).toBe(false);
    expect(
      proposalDiffers(
        proposal({ reason: 'no_cost', newPrice: null, newCost: m('0') }),
        {
          reason: 'no_cost',
          ruleId: 1,
          price: null,
        },
        m('0'),
      ),
    ).toBe(false);
  });

  it('is true for another price, cost, rule or reason, and between a price and none', () => {
    expect(proposalDiffers(proposal(), { ...same, price: m('27.99') }, m('20'))).toBe(true);
    expect(proposalDiffers(proposal(), same, m('21'))).toBe(true);
    expect(proposalDiffers(proposal(), { ...same, ruleId: 2 }, m('20'))).toBe(true);
    expect(proposalDiffers(proposal(), { ...same, reason: 'rule_changed' }, m('20'))).toBe(true);
    expect(proposalDiffers(proposal(), { ...same, reason: 'cost_changed' }, m('20'))).toBe(true);
    expect(proposalDiffers(proposal(), { ...same, price: null }, m('20'))).toBe(true);
    expect(proposalDiffers(proposal({ newPrice: null }), same, m('20'))).toBe(true);
  });
});

describe('followHasWork: what the unlocked read lets through', () => {
  const work = (decision: FollowDecision, over: Partial<FollowFacts> = {}, waiting: WaitingProposal | null = null) =>
    followHasWork(decision, facts(over), waiting);

  it('takes every drop, detach and write, and never a price no rule covers', () => {
    expect(work({ kind: 'drop' })).toBe(true);
    expect(work({ kind: 'detach' })).toBe(true);
    expect(work({ kind: 'write', reason: 'cost_changed', ruleId: 1, price: m('14') })).toBe(true);
    expect(work({ kind: 'leave' })).toBe(false);
    expect(work({ kind: 'leave' }, {}, proposal())).toBe(false);
  });

  it('takes a settled price only when the follow row is behind or a proposal must close', () => {
    expect(work({ kind: 'settle', ruleId: 1 })).toBe(false);
    expect(work({ kind: 'settle', ruleId: 1 }, { cost: m('11') })).toBe(true);
    expect(work({ kind: 'settle', ruleId: 1 }, {}, proposal())).toBe(true);
  });

  it('takes a proposal to open, or one whose figures moved; an unchanged one is left alone', () => {
    const decision = { kind: 'propose', reason: 'cost_jump', ruleId: 1, price: m('26.99') } as const;
    expect(work(decision, { cost: m('20') })).toBe(true);
    expect(work(decision, { cost: m('20') }, proposal())).toBe(false);
    expect(work(decision, { cost: m('21') }, proposal())).toBe(true);
  });
});

describe('approvedFigure: what staff approved is what they were shown', () => {
  it('is the figure of the proposal when the list showed exactly that', () => {
    expect(approvedFigure('26.9900', '26.9900')).toEqual(m('26.99'));
  });

  it('is nothing when the proposal shows another figure than the list did, as after a rewrite by the pass', () => {
    expect(approvedFigure('260.9900', '26.9900')).toBeNull();
    expect(approvedFigure('26.9900', null)).toBeNull();
    expect(approvedFigure(null, '26.9900')).toBeNull();
  });

  it('is nothing for a proposal without a figure, even when the list showed none either', () => {
    expect(approvedFigure(null, null)).toBeNull();
  });

  it('compares the text, so a figure too large for money is refused and never parsed', () => {
    expect(approvedFigure('26.9900', `${'9'.repeat(40)}.0000`)).toBeNull();
    expect(approvedFigure('26.9900', '026.9900')).toBeNull();
  });
});

describe('judgeApproval: staff approve the figure they saw', () => {
  const settle = { kind: 'settle', ruleId: 1 } as const;
  const write = { kind: 'write', reason: 'cost_changed', ruleId: 1, price: m('26.99') } as const;
  const jump = { kind: 'propose', reason: 'cost_jump', ruleId: 1, price: m('26.99') } as const;

  it('applies the rule price when it is the figure shown, whatever the size of the move', () => {
    expect(judgeApproval(jump, priced('26.99'), m('26.99'))).toEqual({ kind: 'apply', price: m('26.99'), ruleId: 1 });
    expect(judgeApproval(write, priced('26.99'), m('26.99'))).toMatchObject({ kind: 'apply' });
    expect(judgeApproval(settle, priced('13.99'), m('13.99'))).toMatchObject({ kind: 'apply' });
  });

  it('writes nothing when the figure moved', () => {
    expect(judgeApproval(jump, priced('27.99'), m('26.99'))).toEqual({ kind: 'moved' });
    expect(judgeApproval(write, priced('27.99'), m('26.99'))).toEqual({ kind: 'moved' });
    expect(judgeApproval(settle, priced('13.99'), m('26.99'))).toEqual({ kind: 'moved' });
  });

  it('a proposal without a figure (no cost) is never applied once the service has a cost again', () => {
    expect(judgeApproval(jump, priced('26.99'), null)).toEqual({ kind: 'moved' });
  });

  it('writes nothing when staff approved no figure, even one the rule gives', () => {
    expect(judgeApproval(jump, priced('260.99'), approvedFigure('260.99', '26.99'))).toEqual({ kind: 'moved' });
    expect(judgeApproval(write, priced('26.99'), approvedFigure('260.99', '26.99'))).toEqual({ kind: 'moved' });
  });

  it('answers no_rule, no_cost and gone', () => {
    expect(judgeApproval({ kind: 'leave' }, null, m('26.99'))).toEqual({ kind: 'no_rule' });
    expect(
      judgeApproval({ kind: 'propose', reason: 'no_cost', ruleId: 1, price: null }, { kind: 'no_cost' }, m('26.99')),
    ).toEqual({ kind: 'no_cost' });
    expect(judgeApproval({ kind: 'drop' }, null, m('26.99'))).toEqual({ kind: 'gone' });
    expect(judgeApproval({ kind: 'detach' }, priced('26.99'), m('26.99'))).toEqual({ kind: 'gone' });
  });
});
