// Unit tests of the alert evaluator's pure rules: comparison, subject keys, the fire/resolve decision, the three ok minutes of a measured recovery and the
// reminder rounds.
import { describe, expect, it } from 'bun:test';
import {
  HOLD_TOLERANCE_MS,
  RECOVERY_SECONDS,
  REMINDER_INTERVAL_MS,
  STREAK_MAX_GAP_MS,
  SYSTEM_SUBJECT,
  type HeldFacts,
  type Streak,
  breaches,
  conditionOf,
  decide,
  isMuted,
  judgeHeld,
  judgeMeasured,
  reminderRound,
  round4,
  subjectKeyOf,
} from './alert-evaluation';

describe('breaches', () => {
  it('compares with the rule comparator, strictly for gt and lt', () => {
    expect(breaches('gt', 20.0001, 20)).toBe(true);
    expect(breaches('gt', 20, 20)).toBe(false);
    expect(breaches('gte', 20, 20)).toBe(true);
    expect(breaches('lt', 150, 150)).toBe(false);
    expect(breaches('lt', 149.9, 150)).toBe(true);
    expect(breaches('lte', 150, 150)).toBe(true);
  });

  it('judges the value with the 4 decimals it is stored with', () => {
    expect(round4(20.00004)).toBe(20);
    expect(breaches('gt', 20.00004, 20)).toBe(false);
    expect(breaches('gt', 20.00006, 20)).toBe(true);
  });
});

describe('subjectKeyOf', () => {
  it('is unique per rule subject: system, supplier id, queue name', () => {
    expect(subjectKeyOf(SYSTEM_SUBJECT)).toBe('system');
    expect(subjectKeyOf({ type: 'supplier', id: 6, label: 'Bosphorus Unlock' })).toBe('supplier:6');
    expect(subjectKeyOf({ type: 'queue', id: null, label: 'orders.dispatch' })).toBe('queue:orders.dispatch');
    expect(subjectKeyOf({ type: 'queue', id: null, label: 'files' })).not.toBe(
      subjectKeyOf({ type: 'queue', id: null, label: 'imports' }),
    );
  });
});

describe('decide', () => {
  const base = { comparator: 'gt', threshold: 20, open: false, muted: false } as const;

  it('fires a breached value with no open alert', () => {
    expect(decide({ ...base, value: 23.4 })).toBe('fire');
  });

  it('keeps a breached value that already has an open alert, so an open alert never fires twice', () => {
    expect(decide({ ...base, value: 23.4, open: true })).toBe('keep');
  });

  it('resolves an open alert whose value is back in range, acknowledged or not', () => {
    expect(decide({ ...base, value: 4, open: true })).toBe('resolve');
  });

  it('does nothing for a value in range with no open alert', () => {
    expect(decide({ ...base, value: 4 })).toBe('skip');
  });

  it('opens nothing while the rule is muted, but still resolves an open alert (Q29)', () => {
    expect(decide({ ...base, value: 30, muted: true })).toBe('skip');
    expect(decide({ ...base, value: 4, open: true, muted: true })).toBe('resolve');
    expect(decide({ ...base, value: 30, open: true, muted: true })).toBe('keep');
  });

  it('neither fires nor resolves without data', () => {
    expect(decide({ ...base, value: null })).toBe('skip');
    expect(decide({ ...base, value: null, open: true })).toBe('skip');
    expect(decide({ ...base, value: Number.NaN, open: true })).toBe('skip');
  });
});

describe('isMuted', () => {
  const now = new Date('2026-11-07T10:00:00.000Z');
  it('is on while muted_until is after now; a past time or none is not muted', () => {
    expect(isMuted(new Date('2026-11-07T10:00:01.000Z'), now)).toBe(true);
    expect(isMuted(new Date('2026-11-07T10:00:00.000Z'), now)).toBe(false);
    expect(isMuted(new Date('2026-11-07T09:00:00.000Z'), now)).toBe(false);
    expect(isMuted(null, now)).toBe(false);
  });
});

describe('conditionOf', () => {
  it('is equal for rules that judge alike, whatever the numeric text, and differs when the metric, comparator or threshold does', () => {
    const rule = { metric: 'supplier.balance', comparator: 'lt', threshold: '150.0000' } as const;
    expect(conditionOf(rule)).toBe(conditionOf({ ...rule, threshold: 150 }));
    expect(conditionOf(rule)).not.toBe(conditionOf({ ...rule, threshold: '151.0000' }));
    expect(conditionOf(rule)).not.toBe(conditionOf({ ...rule, comparator: 'lte' }));
    expect(conditionOf(rule)).not.toBe(conditionOf({ ...rule, metric: 'orders.past_sla' }));
  });
});

describe('judgeHeld', () => {
  const T0 = new Date('2026-11-07T10:00:00.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const condition = 'supplier.balance|lt|150';
  const base = {
    comparator: 'lt',
    threshold: 150,
    windowSeconds: 180,
    condition,
    open: false,
    muted: false,
    streak: null,
  } as const;
  const facts = (overrides: Partial<HeldFacts> & { now: Date }): HeldFacts => ({ value: 100, ...base, ...overrides });
  const streak = (kind: Streak['kind'], since: Date, seenAt: Date): Streak => ({ kind, condition, since, seenAt });

  it('starts a stretch on the first breached reading and fires nothing yet', () => {
    expect(judgeHeld(facts({ now: T0 }))).toEqual({ decision: 'skip', streak: streak('breach', T0, T0) });
  });

  it('keeps counting while the breach goes on, and fires once every reading of the whole window was breached', () => {
    const running = streak('breach', T0, at(120));
    expect(judgeHeld(facts({ now: at(150), streak: running }))).toEqual({
      decision: 'skip',
      streak: streak('breach', T0, at(150)),
    });
    expect(judgeHeld(facts({ now: at(180), streak: streak('breach', T0, at(120)) }))).toEqual({
      decision: 'fire',
      streak: null,
    });
  });

  it('counts a reading a few seconds early as the full window (the schedule has jitter), and no earlier than that', () => {
    const running = streak('breach', T0, at(60));
    const within = new Date(T0.getTime() + 180_000 - HOLD_TOLERANCE_MS);
    expect(judgeHeld(facts({ now: within, streak: running })).decision).toBe('fire');
    expect(judgeHeld(facts({ now: new Date(within.getTime() - 1), streak: running })).decision).toBe('skip');
  });

  it('starts over when the value went back in range, so a spike shorter than the window never fires', () => {
    const running = streak('breach', T0, at(60));
    expect(judgeHeld(facts({ now: at(120), value: 200, streak: running }))).toEqual({ decision: 'skip', streak: null });
    expect(judgeHeld(facts({ now: at(180), streak: null })).streak).toEqual(streak('breach', at(180), at(180)));
  });

  it('breaks the stretch on a missing reading: nothing says the condition held at that moment', () => {
    const running = streak('breach', T0, at(60));
    expect(judgeHeld(facts({ now: at(120), value: null, streak: running }))).toEqual({
      decision: 'skip',
      streak: null,
    });
    expect(judgeHeld(facts({ now: at(120), value: Number.NaN, streak: running }))).toEqual({
      decision: 'skip',
      streak: null,
    });
  });

  it('starts over when the stretch was not seen for longer than the gap (the rule was off, a source was down)', () => {
    const stale = streak('breach', T0, T0);
    const later = new Date(T0.getTime() + STREAK_MAX_GAP_MS + 1);
    expect(judgeHeld(facts({ now: later, streak: stale }))).toEqual({
      decision: 'skip',
      streak: streak('breach', later, later),
    });
  });

  it('ignores a stretch that began under another metric, comparator or threshold', () => {
    const old: Streak = { ...streak('breach', T0, at(60)), condition: 'supplier.balance|lt|120' };
    expect(judgeHeld(facts({ now: at(180), streak: old }))).toEqual({
      decision: 'skip',
      streak: streak('breach', at(180), at(180)),
    });
  });

  it('keeps the stretch running while the rule is muted but opens nothing; the alert opens at once when the mute ends', () => {
    const running = streak('breach', T0, at(120));
    expect(judgeHeld(facts({ now: at(180), muted: true, streak: running }))).toEqual({
      decision: 'skip',
      streak: streak('breach', T0, at(180)),
    });
    expect(judgeHeld(facts({ now: at(240), muted: false, streak: streak('breach', T0, at(180)) })).decision).toBe(
      'fire',
    );
  });

  it('keeps an open alert open while it is breached and needs no stretch for it', () => {
    expect(judgeHeld(facts({ now: at(600), open: true, streak: streak('breach', T0, at(540)) }))).toEqual({
      decision: 'keep',
      streak: null,
    });
  });

  it('resolves an open alert only after every reading of the whole window was back in range', () => {
    const recovered = { open: true, value: 200 } as const;
    expect(judgeHeld(facts({ ...recovered, now: T0 }))).toEqual({ decision: 'keep', streak: streak('clear', T0, T0) });
    expect(judgeHeld(facts({ ...recovered, now: at(120), streak: streak('clear', T0, at(60)) })).decision).toBe('keep');
    expect(judgeHeld(facts({ ...recovered, now: at(180), streak: streak('clear', T0, at(120)) }))).toEqual({
      decision: 'resolve',
      streak: null,
    });
  });

  it('restarts the recovery when the value crosses the threshold again, so a value hovering at it opens and closes nothing', () => {
    const clearing = streak('clear', T0, at(120));
    expect(judgeHeld(facts({ now: at(150), open: true, value: 100, streak: clearing }))).toEqual({
      decision: 'keep',
      streak: null,
    });
    expect(judgeHeld(facts({ now: at(180), open: true, value: 200, streak: null })).streak).toEqual(
      streak('clear', at(180), at(180)),
    );
  });

  it('does nothing for a subject that is in range and has no open alert, and drops any stretch it had', () => {
    expect(judgeHeld(facts({ now: at(60), value: 200, streak: streak('breach', T0, T0) }))).toEqual({
      decision: 'skip',
      streak: null,
    });
  });

  it('does not take a recovery stretch for a breach stretch', () => {
    const clearing = streak('clear', T0, at(60));
    expect(judgeHeld(facts({ now: at(180), streak: clearing }))).toEqual({
      decision: 'skip',
      streak: streak('breach', at(180), at(180)),
    });
  });
});

describe('judgeMeasured', () => {
  const T0 = new Date('2026-11-07T10:00:00.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const condition = 'supplier.timeout_rate|gt|20';
  const base = {
    comparator: 'gt',
    threshold: 20,
    windowSeconds: 3600,
    condition,
    open: false,
    muted: false,
    streak: null,
  } as const;
  const facts = (overrides: Partial<HeldFacts> & { now: Date }): HeldFacts => ({ value: 5, ...base, ...overrides });
  const clearing = (since: Date, seenAt: Date): Streak => ({ kind: 'clear', condition, since, seenAt });

  it('closes after three minutes, whatever the rule window (an hour here), and not before', () => {
    expect(RECOVERY_SECONDS).toBe(180);
    expect(judgeMeasured(facts({ now: T0, open: true }))).toEqual({ decision: 'keep', streak: clearing(T0, T0) });
    expect(judgeMeasured(facts({ now: at(120), open: true, streak: clearing(T0, at(60)) })).decision).toBe('keep');
    expect(judgeMeasured(facts({ now: at(180), open: true, streak: clearing(T0, at(120)) }))).toEqual({
      decision: 'resolve',
      streak: null,
    });
  });

  it('fires a breach at once, like the plain decision, and keeps no stretch', () => {
    expect(judgeMeasured(facts({ now: T0, value: 25 }))).toEqual({ decision: 'fire', streak: null });
    expect(judgeMeasured(facts({ now: T0, value: 25, open: true }))).toEqual({ decision: 'keep', streak: null });
    expect(judgeMeasured(facts({ now: T0, value: 25, muted: true }))).toEqual({ decision: 'skip', streak: null });
  });

  it('starts the three minutes again when the value breaches in between, and when the stretch was not seen for the gap', () => {
    expect(judgeMeasured(facts({ now: at(120), value: 25, open: true, streak: clearing(T0, at(60)) }))).toEqual({
      decision: 'keep',
      streak: null,
    });
    const stale = clearing(T0, at(60));
    const later = at(60 + STREAK_MAX_GAP_MS / 1000 + 1);
    expect(judgeMeasured(facts({ now: later, open: true, streak: stale }))).toEqual({
      decision: 'keep',
      streak: clearing(later, later),
    });
  });

  it('does nothing without data, and for a value in range with no open alert', () => {
    expect(judgeMeasured(facts({ now: T0, value: null, open: true, streak: clearing(T0, T0) }))).toEqual({
      decision: 'skip',
      streak: null,
    });
    expect(judgeMeasured(facts({ now: T0 }))).toEqual({ decision: 'skip', streak: null });
  });
});

describe('reminderRound', () => {
  const T0 = new Date('2026-11-07T10:00:00.000Z');
  const after = (ms: number) => new Date(T0.getTime() + ms);

  it('is 0 until the interval has passed (30 minutes), then counts whole intervals', () => {
    expect(REMINDER_INTERVAL_MS).toBe(30 * 60_000);
    expect(reminderRound(T0, after(0))).toBe(0);
    expect(reminderRound(T0, after(REMINDER_INTERVAL_MS - 1))).toBe(0);
    expect(reminderRound(T0, after(REMINDER_INTERVAL_MS))).toBe(1);
    expect(reminderRound(T0, after(3 * REMINDER_INTERVAL_MS + 60_000))).toBe(3);
  });

  it('never goes below 0 when the clock is before the start', () => {
    expect(reminderRound(T0, after(-60_000))).toBe(0);
  });
});
