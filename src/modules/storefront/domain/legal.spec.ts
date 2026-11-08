// Tests of the legal document rules: type words and slugs, the state of a version, and the audit label.
import { describe, expect, it } from 'bun:test';
import { LEGAL_VERSION_PATTERN, isReservedSlug, legalLabel, legalState, legalTypeOfSlug } from './legal';

describe('legalTypeOfSlug', () => {
  it('reads the four type words and nothing else', () => {
    expect(legalTypeOfSlug('terms')).toBe('terms');
    expect(legalTypeOfSlug('privacy')).toBe('privacy');
    expect(legalTypeOfSlug('refund')).toBe('refund');
    expect(legalTypeOfSlug('cookies')).toBe('cookies');
    expect(legalTypeOfSlug('about')).toBeUndefined();
    expect(legalTypeOfSlug('terms-of-service')).toBeUndefined();
    expect(isReservedSlug('terms')).toBe(true);
    expect(isReservedSlug('about')).toBe(false);
  });
});

describe('legalState', () => {
  it('tells a draft, the current version and an earlier one apart', () => {
    expect(legalState({ isCurrent: false, effectiveFrom: null })).toBe('draft');
    expect(legalState({ isCurrent: true, effectiveFrom: new Date(1) })).toBe('current');
    expect(legalState({ isCurrent: false, effectiveFrom: new Date(1) })).toBe('earlier');
  });
});

describe('legalLabel', () => {
  it('writes the demo label: type, language in capitals, version', () => {
    expect(legalLabel({ type: 'terms', locale: 'en', version: '3.2' })).toBe('Terms of service (EN) 3.2');
    expect(legalLabel({ type: 'cookies', locale: 'ar', version: '1.0' })).toBe('Cookie policy (AR) 1.0');
  });
});

describe('LEGAL_VERSION_PATTERN', () => {
  it.each(['3.2', '1.5', '2026-01', 'v2', '10'])('accepts %p', (value) => {
    expect(LEGAL_VERSION_PATTERN.test(value)).toBe(true);
  });
  it.each(['', ' 3.2', '3 2', '.1', '3.2!'])('refuses %p', (value) => {
    expect(LEGAL_VERSION_PATTERN.test(value)).toBe(false);
  });
});
