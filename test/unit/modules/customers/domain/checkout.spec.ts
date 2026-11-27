// Unit tests of the checkout session and consent rules (feature 14a).
import { describe, expect, it } from 'bun:test';
import {
  consentState,
  effectiveStatus,
  isLiveCheckout,
  isShopAddress,
  maskEmail,
  maskImei,
  requiredConsents,
} from '@src/modules/customers/domain/checkout';

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

describe('isLiveCheckout (the guest claim and the open_checkout blocker read a session as in flight)', () => {
  const expires = at('2026-11-07T12:30:00.000Z');
  it('is true only for an open session that has not run out', () => {
    expect(isLiveCheckout({ status: 'open', expiresAt: expires }, at('2026-11-07T12:29:59.999Z'))).toBe(true);
    // The end is exclusive, as for effectiveStatus: at the very moment it runs out the session is history.
    expect(isLiveCheckout({ status: 'open', expiresAt: expires }, at('2026-11-07T12:30:00.000Z'))).toBe(false);
    expect(isLiveCheckout({ status: 'open', expiresAt: expires }, at('2026-11-08T00:00:00.000Z'))).toBe(false);
  });

  it('is false for a paid or an expired session, whatever the clock says', () => {
    expect(isLiveCheckout({ status: 'paid', expiresAt: expires }, at('2026-11-07T12:00:00.000Z'))).toBe(false);
    expect(isLiveCheckout({ status: 'expired', expiresAt: expires }, at('2026-11-07T12:00:00.000Z'))).toBe(false);
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

  it('shows a list of IMEIs (an imei_bulk main input, decision 076) as its first IMEI masked and the count of the others', () => {
    expect(maskImei('353890110000004\n352905112490861\n354607111076240')).toBe('•••••••••••0004 +2 more');
    expect(maskImei('353890110000004\r\n352905112490861')).toBe('•••••••••••0004 +1 more');
    // A one-item list reads like one IMEI.
    expect(maskImei('353890110000004')).toBe(maskImei('353890110000004\n'));
    // Thirty IMEIs stay short enough for a phone.
    expect(maskImei(Array.from({ length: 30 }, () => '353890110000004').join('\n'))).toBe('•••••••••••0004 +29 more');
  });
});

describe('isShopAddress (decision 048)', () => {
  const bases = ['https://shop.gsm.example', 'https://portal.gsm.example', 'not a url'];

  it("a return address must be on the shop's origin", () => {
    expect(isShopAddress('https://shop.gsm.example/en/checkout/return?token=abc', bases)).toBe(true);
    expect(isShopAddress('https://shop.gsm.example', bases)).toBe(true);
    expect(isShopAddress('https://portal.gsm.example/wallet', bases)).toBe(true);
    for (const url of [
      'https://other.example/return',
      'https://shop.gsm.example:8443/return',
      'http://shop.gsm.example/return',
      'https://user@shop.gsm.example/return',
      'https://user:pw@shop.gsm.example/return',
      'https://shop.gsm.example.other.example/return',
      'not a url',
    ]) {
      expect(isShopAddress(url, bases)).toBe(false);
    }
    // A development origin with a port is matched exactly.
    expect(isShopAddress('http://localhost:5175/en/checkout/return', ['http://localhost:5175'])).toBe(true);
    expect(isShopAddress('http://localhost:5174/en/checkout/return', ['http://localhost:5175'])).toBe(false);
  });
});
