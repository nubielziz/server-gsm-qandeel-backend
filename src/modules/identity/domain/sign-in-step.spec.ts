// Unit tests of the sign-in step rules: password first, then the code or the enrolment, and the stage that holds each step.
import { describe, expect, it } from 'bun:test';
import { nextStepOf, stageOfStep } from './sign-in-step';

describe('nextStepOf', () => {
  it('asks for the password change first, whatever the 2FA state', () => {
    expect(nextStepOf({ mustChangePassword: true, twofaEnabled: true })).toBe('password');
    expect(nextStepOf({ mustChangePassword: true, twofaEnabled: false })).toBe('password');
  });

  it('asks for a code when 2FA is on and for an enrolment when it is not', () => {
    expect(nextStepOf({ mustChangePassword: false, twofaEnabled: true })).toBe('totp');
    expect(nextStepOf({ mustChangePassword: false, twofaEnabled: false })).toBe('totp_setup');
  });
});

describe('stageOfStep', () => {
  it('names the pending stage of each step', () => {
    expect(stageOfStep('password')).toBe('pending_password');
    expect(stageOfStep('totp')).toBe('pending_totp');
    expect(stageOfStep('totp_setup')).toBe('pending_totp_setup');
  });
});
