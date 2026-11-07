// Unit tests of the checkout session and consent rules (feature 14a).
import { describe, expect, it } from 'bun:test';
import { consentState, effectiveStatus, maskEmail, maskImei, requiredConsents } from './checkout';

const at = (iso: string) => new Date(iso);

describe('requiredConsents', () => {
  it('needs the terms and the privacy policy, and the waiver when the policy is on', () => {
    expect(requiredConsents(true)).toEqual(['terms', 'privacy', 'withdrawal_waiver']);
    expect(requiredConsents(false)).toEqual(['terms', 'privacy']);
  });
});

describe('effectiveStatus', () => {
  const expires = at('2026-11-07T12:30:00.000Z');
  it('keeps an open session open until the moment it runs out, and expires it from then on', () => {
    expect(effectiveStatus('open', expires, at('2026-11-07T12:29:59.999Z'))).toBe('open');
    expect(effectiveStatus('open', expires, at('2026-11-07T12:30:00.000Z'))).toBe('expired');
    expect(effectiveStatus('open', expires, at('2026-11-08T00:00:00.000Z'))).toBe('expired');
  });

  it('never turns a paid or expired session into anything else', () => {
    expect(effectiveStatus('paid', expires, at('2027-01-01T00:00:00.000Z'))).toBe('paid');
    expect(effectiveStatus('expired', expires, at('2026-11-07T12:00:00.000Z'))).toBe('expired');
  });
});

describe('consentState', () => {
  const fact = (
    id: number,
    purpose: 'terms' | 'privacy' | 'withdrawal_waiver' | 'marketing',
    granted: boolean,
    time: string,
  ) => ({
    id,
    purpose,
    granted,
    createdAt: at(time),
  });
  const required = requiredConsents(true);

  it('is incomplete without records', () => {
    expect(consentState([], required)).toEqual({ required, granted: [], complete: false });
  });

  it('is complete when every required purpose is granted, whatever else was recorded', () => {
    const state = consentState(
      [
        fact(1, 'terms', true, '2026-11-07T12:00:00.000Z'),
        fact(2, 'privacy', true, '2026-11-07T12:00:00.000Z'),
        fact(3, 'withdrawal_waiver', true, '2026-11-07T12:00:00.000Z'),
        fact(4, 'marketing', false, '2026-11-07T12:00:00.000Z'),
      ],
      required,
    );
    expect(state).toEqual({ required, granted: ['terms', 'privacy', 'withdrawal_waiver'], complete: true });
  });

  it('lets the latest record of a purpose decide: a withdrawn consent is a new row', () => {
    const facts = [
      fact(1, 'terms', true, '2026-11-07T12:00:00.000Z'),
      fact(2, 'privacy', true, '2026-11-07T12:00:00.000Z'),
      fact(3, 'terms', false, '2026-11-07T12:05:00.000Z'),
    ];
    expect(consentState(facts, requiredConsents(false))).toEqual({
      required: ['terms', 'privacy'],
      granted: ['privacy'],
      complete: false,
    });
    // Same second: the later id wins.
    const tie = [
      fact(5, 'terms', false, '2026-11-07T12:00:00.000Z'),
      fact(6, 'terms', true, '2026-11-07T12:00:00.000Z'),
    ];
    expect(consentState(tie, ['terms']).granted).toEqual(['terms']);
  });

  it('does not need the waiver when the policy is off', () => {
    const facts = [
      fact(1, 'terms', true, '2026-11-07T12:00:00.000Z'),
      fact(2, 'privacy', true, '2026-11-07T12:00:00.000Z'),
    ];
    expect(consentState(facts, requiredConsents(false)).complete).toBe(true);
    expect(consentState(facts, requiredConsents(true)).complete).toBe(false);
  });
});

describe('masks', () => {
  it('shows two characters of the email and the domain', () => {
    expect(maskEmail('daniel.whitmore@mail.example')).toBe('da•••@mail.example');
    expect(maskEmail('a@b.example')).toBe('a•••@b.example');
    expect(maskEmail('nope')).toBe('•••');
  });

  it('shows the last four digits of an IMEI', () => {
    expect(maskImei('353890110000004')).toBe('•••••••••••0004');
    expect(maskImei('123')).toBe('123');
  });
});
