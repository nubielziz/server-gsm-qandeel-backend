// Unit tests of the webhook signature scheme (decision 019): format, verification, the 5-minute window, tampering,
// secret rotation (several v1 values) and malformed headers.
import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { AppError } from '../../common/errors';
import {
  WEBHOOK_TOLERANCE_SECONDS,
  assertWebhookSignature,
  signWebhook,
  verifyWebhookSignature,
} from './webhook-signature';

const SECRET = 'whsec_test_secret_value';
const BODY = '{"id":"evt_1","type":"order.status_changed","data":{"orderId":42}}';
const NOW = 1_800_000_000;

describe('signWebhook', () => {
  it('writes t=<unix>,v1=<hex> where v1 is HMAC-SHA256 of "<t>.<body>"', () => {
    const header = signWebhook(SECRET, NOW, BODY);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
    expect(header).toBe(`t=${NOW},v1=${expected}`);
  });

  it('signs bytes exactly like the same text', () => {
    expect(signWebhook(SECRET, NOW, new TextEncoder().encode(BODY))).toBe(signWebhook(SECRET, NOW, BODY));
  });
});

describe('verifyWebhookSignature', () => {
  const signed = signWebhook(SECRET, NOW, BODY);

  it('accepts a good signature and returns the signed timestamp', () => {
    expect(verifyWebhookSignature(SECRET, signed, BODY, { nowSeconds: NOW })).toEqual({ valid: true, timestamp: NOW });
  });

  it('accepts a delivery up to 5 minutes away from now, in either direction, and refuses 5 minutes and 1 second', () => {
    const at = (offset: number) => verifyWebhookSignature(SECRET, signed, BODY, { nowSeconds: NOW + offset });
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    expect(at(0).valid).toBe(true);
    expect(at(299).valid).toBe(true);
    expect(at(300).valid).toBe(true);
    expect(at(-300).valid).toBe(true);
    expect(at(301)).toEqual({ valid: false, reason: 'outside_window' });
    expect(at(-301)).toEqual({ valid: false, reason: 'outside_window' });
    expect(at(86_400)).toEqual({ valid: false, reason: 'outside_window' });
  });

  it('uses the system clock when no time is given', () => {
    const fresh = signWebhook(SECRET, Math.floor(Date.now() / 1000), BODY);
    expect(verifyWebhookSignature(SECRET, fresh, BODY).valid).toBe(true);
    const old = signWebhook(SECRET, Math.floor(Date.now() / 1000) - 3600, BODY);
    expect(verifyWebhookSignature(SECRET, old, BODY)).toEqual({ valid: false, reason: 'outside_window' });
  });

  it('honours a custom window', () => {
    expect(verifyWebhookSignature(SECRET, signed, BODY, { nowSeconds: NOW + 61, toleranceSeconds: 60 }).valid).toBe(
      false,
    );
    expect(verifyWebhookSignature(SECRET, signed, BODY, { nowSeconds: NOW + 60, toleranceSeconds: 60 }).valid).toBe(
      true,
    );
  });

  it('refuses a changed body, secret or timestamp', () => {
    const ok = { nowSeconds: NOW };
    expect(verifyWebhookSignature(SECRET, signed, `${BODY} `, ok)).toEqual({ valid: false, reason: 'mismatch' });
    expect(verifyWebhookSignature('another-secret', signed, BODY, ok)).toEqual({ valid: false, reason: 'mismatch' });
    // moving the timestamp forward (to dodge the window) breaks the signature, because t is part of the signed text
    const forged = signed.replace(`t=${NOW}`, `t=${NOW + 10}`);
    expect(verifyWebhookSignature(SECRET, forged, BODY, { nowSeconds: NOW + 10 })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('accepts any of several v1 signatures (secret rotation) and ignores unknown schemes', () => {
    const next = signWebhook('new-secret', NOW, BODY).split(',')[1]!;
    const both = `${signed},${next}`;
    expect(verifyWebhookSignature(SECRET, both, BODY, { nowSeconds: NOW }).valid).toBe(true);
    expect(verifyWebhookSignature('new-secret', both, BODY, { nowSeconds: NOW }).valid).toBe(true);
    expect(verifyWebhookSignature(SECRET, `${signed},v2=whatever`, BODY, { nowSeconds: NOW }).valid).toBe(true);
    expect(
      verifyWebhookSignature(SECRET, `t=${NOW}, v1=${signed.split('v1=')[1]}`, BODY, { nowSeconds: NOW }).valid,
    ).toBe(true);
  });

  it('refuses malformed headers without throwing', () => {
    const hex = signed.split('v1=')[1]!;
    for (const header of [
      '',
      'garbage',
      `v1=${hex}`,
      `t=${NOW}`,
      `t=${NOW},v1=short`,
      `t=${NOW},v1=${'z'.repeat(64)}`,
      `t=abc,v1=${hex}`,
      `t=-5,v1=${hex}`,
      `t=${NOW},t=${NOW},v1=${hex}`,
      `t=1.5,v1=${hex}`,
      `=,v1=${hex}`,
      'x'.repeat(5000),
    ]) {
      expect(verifyWebhookSignature(SECRET, header, BODY, { nowSeconds: NOW }), header.slice(0, 40)).toEqual({
        valid: false,
        reason: 'malformed',
      });
    }
  });
});

describe('assertWebhookSignature', () => {
  const signed = signWebhook(SECRET, NOW, BODY);

  it('returns the timestamp when the signature is good', () => {
    expect(assertWebhookSignature(SECRET, signed, BODY, { nowSeconds: NOW })).toBe(NOW);
  });

  it('throws 400 WEBHOOK_SIGNATURE_INVALID for every refusal, with a reason that reveals no secret', () => {
    for (const [header, options] of [
      ['junk', { nowSeconds: NOW }],
      [signed.replace(/.$/, '0'), { nowSeconds: NOW }],
      [signed, { nowSeconds: NOW + 1000 }],
    ] as const) {
      try {
        assertWebhookSignature(SECRET, header, BODY, options);
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('WEBHOOK_SIGNATURE_INVALID');
        expect((error as AppError).status).toBe(400);
        expect(`${(error as AppError).detail}`).not.toContain(SECRET);
      }
    }
  });
});
