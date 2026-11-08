// Unit tests of the incident timeline rules: the declared line, status changes, updates and the closing rule.
import { describe, expect, it } from 'bun:test';
import { DECLARED_TEXT, DEFAULT_TEXT, declaredTimeline, hasRootCause, nextLine } from './incident-timeline';

const at = new Date('2026-11-07T08:30:00.000Z');
const by = { id: 4, name: 'Dana M.' };

describe('declaredTimeline', () => {
  it('starts at investigating with the declared sentence by the staff member', () => {
    expect(declaredTimeline(at, by)).toEqual([
      { at: '2026-11-07T08:30:00.000Z', status: 'investigating', text: DECLARED_TEXT, by },
    ]);
    expect(DECLARED_TEXT).toBe('Incident declared. We are investigating.');
  });
});

describe('nextLine', () => {
  it('writes the update text for a status change', () => {
    const next = nextLine('investigating', { status: 'identified', update: ' The supplier confirmed it. ' }, at, by);
    expect(next.status).toBe('identified');
    expect(next.line).toEqual({
      at: '2026-11-07T08:30:00.000Z',
      status: 'identified',
      text: 'The supplier confirmed it.',
      by,
    });
    expect(next.closes).toBe(false);
  });

  it('writes the default sentence when only the status changes', () => {
    expect(nextLine('identified', { status: 'monitoring' }, at, by).line?.text).toBe(DEFAULT_TEXT.monitoring);
    expect(nextLine('monitoring', { status: 'investigating', update: '  ' }, at, by).line?.text).toBe(
      DEFAULT_TEXT.investigating,
    );
  });

  it('adds a line with the current status for an update without a status', () => {
    const next = nextLine('identified', { update: 'Waiting for the supplier.' }, at, by);
    expect(next.line).toMatchObject({ status: 'identified', text: 'Waiting for the supplier.' });
    expect(next.status).toBe('identified');
  });

  it('writes nothing when neither the status nor an update changed (a title or severity edit)', () => {
    expect(nextLine('identified', {}, at, by)).toEqual({ status: 'identified', line: null, closes: false });
    expect(nextLine('identified', { status: 'identified' }, at, by).line).toBeNull();
  });

  it('closes on resolved, and the closing update (the action taken) is the resolved line', () => {
    const next = nextLine('monitoring', { status: 'resolved', update: 'Supplier back to active.' }, at, by);
    expect(next.closes).toBe(true);
    expect(next.line).toMatchObject({ status: 'resolved', text: 'Supplier back to active.' });
    expect(nextLine('monitoring', { status: 'resolved' }, at, by).line?.text).toBe(DEFAULT_TEXT.resolved);
  });
});

describe('hasRootCause', () => {
  it('needs 10 characters, from the request or from what was saved before', () => {
    expect(hasRootCause('The supplier lowered its rate limit.', null)).toBe(true);
    expect(hasRootCause('too short', null)).toBe(false);
    expect(hasRootCause(undefined, 'Saved earlier with enough text.')).toBe(true);
    expect(hasRootCause(undefined, null)).toBe(false);
    expect(hasRootCause('  ', 'Saved earlier with enough text.')).toBe(false);
  });
});
