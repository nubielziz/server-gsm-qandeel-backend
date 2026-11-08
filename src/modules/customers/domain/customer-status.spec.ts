// Unit tests of the status rules of suspension and sign-in.
import { describe, expect, it } from 'bun:test';
import { SUSPEND_REASONS, canSignIn, sessionStateOf, suspendedReasonText } from './customer-status';

describe('suspendedReasonText', () => {
  it('is the reason alone, or "reason: note" when there is a note', () => {
    expect(suspendedReasonText('Other', undefined)).toBe('Other');
    expect(suspendedReasonText('Other', '')).toBe('Other');
    expect(suspendedReasonText('Account may be compromised', 'Customer called')).toBe(
      'Account may be compromised: Customer called',
    );
  });

  it('offers exactly the five reasons of the console', () => {
    expect(SUSPEND_REASONS).toHaveLength(5);
    expect(SUSPEND_REASONS).toContain('Waiting for proof of identity or payment');
  });
});

describe('canSignIn and sessionStateOf', () => {
  it('lets only an active customer in, and maps blocked like suspended and anonymized like gone', () => {
    expect(canSignIn('active')).toBe(true);
    for (const status of ['suspended', 'blocked', 'anonymized'] as const) expect(canSignIn(status)).toBe(false);
    expect(sessionStateOf('active')).toBe('ok');
    expect(sessionStateOf('suspended')).toBe('suspended');
    expect(sessionStateOf('blocked')).toBe('suspended');
    expect(sessionStateOf('anonymized')).toBe('gone');
  });
});
