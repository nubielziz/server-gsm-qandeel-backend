// Unit tests of the merchant sign-in steps: a temporary password first, then the optional 2FA code, then a full session.
import { describe, expect, it } from 'bun:test';
import { merchantStageOfStep, nextMerchantStep } from '@src/modules/identity/domain/merchant-sign-in-step';

describe('the step after the password', () => {
  it('asks for a new password first, whether or not 2FA is on', () => {
    expect(nextMerchantStep({ mustChangePassword: true, twofaEnabled: true })).toBe('password');
    expect(nextMerchantStep({ mustChangePassword: true, twofaEnabled: false })).toBe('password');
  });

  it('asks for a code when 2FA is on and is done when it is off', () => {
    expect(nextMerchantStep({ mustChangePassword: false, twofaEnabled: true })).toBe('totp');
    expect(nextMerchantStep({ mustChangePassword: false, twofaEnabled: false })).toBe('done');
  });

  it('keeps a pending step in a pending session and opens a full one otherwise', () => {
    expect(merchantStageOfStep('password')).toBe('pending_password');
    expect(merchantStageOfStep('totp')).toBe('pending_totp');
    expect(merchantStageOfStep('done')).toBe('active');
  });
});
