// Unit tests of the daily cap on wrong authenticator codes of one account.
import { describe, expect, it } from 'bun:test';
import {
  CODE_FAILURE_WINDOW_MS,
  MAX_FAILED_CODES,
  closesCodeStep,
  codeStepClosed,
  codeStepWaitText,
  secondsUntilCodeStepOpens,
} from '@src/modules/identity/domain/code-step-lock';

describe('codeStepClosed', () => {
  it('lets twenty counted attempts be checked and refuses from the twenty-first on', () => {
    expect(MAX_FAILED_CODES).toBe(20);
    expect(CODE_FAILURE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(codeStepClosed(1, false)).toBe(false);
    expect(codeStepClosed(MAX_FAILED_CODES, false)).toBe(false);
    expect(codeStepClosed(MAX_FAILED_CODES + 1, false)).toBe(true);
    expect(codeStepClosed(MAX_FAILED_CODES + 50, false)).toBe(true);
  });

  it('refuses every attempt while the closing of the current 24 hours is recorded, whatever the count', () => {
    expect(codeStepClosed(1, true)).toBe(true);
    expect(codeStepClosed(MAX_FAILED_CODES, true)).toBe(true);
  });
});

describe('closesCodeStep', () => {
  it('is true only for the wrong code that reaches the cap, so the closing is recorded once', () => {
    expect(closesCodeStep(MAX_FAILED_CODES - 1)).toBe(false);
    expect(closesCodeStep(MAX_FAILED_CODES)).toBe(true);
    expect(closesCodeStep(MAX_FAILED_CODES + 1)).toBe(false);
  });
});

describe('secondsUntilCodeStepOpens', () => {
  const since = new Date('2026-11-23T10:00:00.000Z');

  it('is the time left of the 24 hours from the first counted wrong code, in whole seconds rounded up', () => {
    expect(secondsUntilCodeStepOpens(since, since)).toBe(86_400);
    expect(secondsUntilCodeStepOpens(since, new Date('2026-11-23T11:20:00.000Z'))).toBe(81_600);
    expect(secondsUntilCodeStepOpens(since, new Date('2026-11-24T09:59:59.500Z'))).toBe(1);
  });

  it('is never below one second', () => {
    expect(secondsUntilCodeStepOpens(since, new Date('2026-11-24T10:00:00.000Z'))).toBe(1);
    expect(secondsUntilCodeStepOpens(since, new Date('2026-11-25T10:00:00.000Z'))).toBe(1);
  });
});

describe('codeStepWaitText', () => {
  it('names the wait in hours and minutes, the minutes rounded up', () => {
    expect(codeStepWaitText(1)).toBe('1 minute');
    expect(codeStepWaitText(61)).toBe('2 minutes');
    expect(codeStepWaitText(3_600)).toBe('1 hour');
    expect(codeStepWaitText(3_601)).toBe('1 hour 1 minute');
    expect(codeStepWaitText(81_600)).toBe('22 hours 40 minutes');
    expect(codeStepWaitText(86_400)).toBe('24 hours');
  });
});
