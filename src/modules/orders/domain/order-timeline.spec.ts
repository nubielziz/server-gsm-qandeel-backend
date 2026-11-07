// Unit tests of the timeline lines of each transition (RESOLUTIONS orders-suppliers-15): which events, in which order, with which words.
import { describe, expect, it } from 'bun:test';
import {
  MANUAL_REASON,
  SYSTEM_ACTOR,
  VERIFICATION_REASON,
  createdLine,
  dollars,
  holdLine,
  manualReviewLine,
  transitionLines,
} from './order-timeline';

const staff = { type: 'staff', id: 7 } as const;
const money = { posted: true, amount: '3.3100', cost: '2.4000' };
const kinds = (lines: Array<{ type: string }>) => lines.map((line) => line.type);

describe('dollars', () => {
  it('writes cents when the last two decimals are zero and four decimals otherwise', () => {
    expect(dollars('3.3100')).toBe('$3.31');
    expect(dollars('73.8000')).toBe('$73.80');
    expect(dollars('0.0900')).toBe('$0.09');
    expect(dollars('0.0750')).toBe('$0.0750');
    expect(dollars('0.0000')).toBe('$0.00');
  });
});

describe('placement lines', () => {
  it('names the source, the held price and the manual reason like the console', () => {
    expect(createdLine('dhru', { type: 'client', id: 3 }).data).toMatchObject({
      message: 'Order received via Dhru API',
      source: 'dhru',
    });
    expect(createdLine('portal', { type: 'client', id: 3 }).data.message).toBe('Order received via Portal');
    expect(holdLine('3.3100', 'Phone Doctor FZE')).toMatchObject({
      type: 'hold',
      actor: SYSTEM_ACTOR,
      data: { message: '$3.31 held from Phone Doctor FZE wallet', amount: '3.3100' },
    });
    expect(manualReviewLine()).toMatchObject({ type: 'review', data: { reason: MANUAL_REASON } });
  });
});

describe('transitionLines', () => {
  const base = { actor: staff, from: 'processing', to: 'completed', money } as const;

  it('a completion by the supplier says so, a completion by staff says staff reply', () => {
    const bySupplier = transitionLines('completed', 'complete', { ...base, actor: { type: 'supplier', id: 4 } });
    expect(bySupplier[0]).toMatchObject({
      type: 'completed',
      actor: { type: 'supplier', id: 4 },
      data: { message: 'Completed by the supplier' },
    });
    expect(transitionLines('completed', 'complete', base)[0]!.data.message).toBe('Completed by staff reply');
  });

  it('accept writes accepted', () => {
    const lines = transitionLines('accepted', null, { ...base, to: 'processing', from: 'pending' });
    expect(kinds(lines)).toEqual(['accepted']);
    expect(lines[0]).toMatchObject({ fromStatus: 'pending', toStatus: 'processing', actor: staff });
  });

  it('reply writes completed then settle (system) with the revenue and the cost', () => {
    const lines = transitionLines('completed', 'complete', base);
    expect(kinds(lines)).toEqual(['completed', 'settle']);
    expect(lines[1]!.actor).toEqual(SYSTEM_ACTOR);
    expect(lines[1]!.data).toMatchObject({
      message: 'Settled: revenue $3.31, cost $2.40',
      revenue: '3.3100',
      cost: '2.4000',
    });
  });

  it('reject writes rejected then release; a B2C reject writes refund instead of release', () => {
    const b2b = transitionLines('rejected', 'reject', { ...base, to: 'rejected', reason: 'IMEI is blacklisted' });
    expect(kinds(b2b)).toEqual(['rejected', 'release']);
    expect(b2b[0]!.data).toMatchObject({ message: 'IMEI is blacklisted', reason: 'IMEI is blacklisted' });
    expect(b2b[1]!.data.message).toBe('$3.31 released back to wallet');
    const b2c = transitionLines('rejected', 'b2c_refund', { ...base, to: 'rejected', reason: 'No' });
    expect(kinds(b2c)).toEqual(['rejected', 'refund']);
  });

  it('a B2B refund writes rejected then refund with the reason', () => {
    const lines = transitionLines('refund', 'refund', {
      ...base,
      from: 'completed',
      to: 'rejected',
      reason: 'Charged twice',
    });
    expect(kinds(lines)).toEqual(['rejected', 'refund']);
    expect(lines[1]!.data).toMatchObject({ message: '$3.31 refunded to the wallet', reason: 'Charged twice' });
  });

  it('reopen writes one reopened line, with or without a reason', () => {
    const withReason = transitionLines('reopened', 'reopen', {
      ...base,
      from: 'completed',
      to: 'processing',
      reason: 'Bad code',
    });
    expect(withReason[0]!.data).toMatchObject({ message: 'Reopened: Bad code', reason: 'Bad code' });
    const without = transitionLines('reopened', 'reopen', { ...base, from: 'completed', to: 'processing' });
    expect(without[0]!.data.message).toBe('Reopened, back to Processing');
  });

  it('a verification request carries the reason of the queue; a decision carries the decision, a refund adds its lines', () => {
    const asked = transitionLines('verification', null, {
      ...base,
      actor: { type: 'client', id: 3 },
      from: 'completed',
      to: 'completed',
    });
    expect(asked[0]!.data).toMatchObject({ reason: VERIFICATION_REASON });
    const accepted = transitionLines('verification', null, {
      ...base,
      from: 'completed',
      to: 'completed',
      decision: 'accept',
      note: 'Checked',
    });
    expect(kinds(accepted)).toEqual(['verification']);
    expect(accepted[0]!.data).toMatchObject({
      decision: 'accept',
      note: 'Checked',
      message: 'Verification: result accepted. Checked',
    });
    const refunded = transitionLines('verification', 'refund', {
      ...base,
      from: 'completed',
      to: 'rejected',
      decision: 'refund',
    });
    expect(kinds(refunded)).toEqual(['verification', 'rejected', 'refund']);
    expect(refunded[1]!.data.reason).toBe('Verification refund');
  });
});
