// Unit tests of the merchant sign-in steps: optional 2FA decides between a code step and a full session.
import { describe, expect, it } from 'bun:test';
import { merchantStageOfStep, nextMerchantStep } from './merchant-sign-in-step';

describe('the step after the password', () => {
  it('asks for a code when 2FA is on and is done when it is off', () => {
    expect(nextMerchantStep(true)).toBe('totp');
    expect(nextMerchantStep(false)).toBe('done');
  });

  it('keeps the code step in a pending session and opens a full one otherwise', () => {
    expect(merchantStageOfStep('totp')).toBe('pending_totp');
    expect(merchantStageOfStep('done')).toBe('active');
  });
});
