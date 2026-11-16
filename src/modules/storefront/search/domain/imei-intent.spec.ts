import { describe, expect, it } from 'bun:test';
import { imeiIntent, luhnValid } from './imei-intent';

describe('imeiIntent', () => {
  it('knows a 15-digit IMEI with a valid Luhn check, with or without separators', () => {
    expect(imeiIntent('356938035643809')).toBe('imei');
    expect(imeiIntent('3569 3803 5643 809')).toBe('imei');
    expect(imeiIntent('35-693803-564380-9')).toBe('imei');
    expect(imeiIntent('35.693803.564380.9')).toBe('imei');
    expect(imeiIntent('  356938035643809  ')).toBe('imei');
  });

  it('knows a 16-digit IMEISV without a check', () => {
    expect(imeiIntent('3569380356438001')).toBe('imei');
    expect(imeiIntent('35 693803 564380 01')).toBe('imei');
  });

  it('refuses a 15-digit number that fails Luhn, other lengths and anything with letters', () => {
    expect(imeiIntent('356938035643808')).toBeNull();
    expect(imeiIntent('35693803564380')).toBeNull();
    expect(imeiIntent('35693803564380911')).toBeNull();
    expect(imeiIntent('sm-a525f')).toBeNull();
    expect(imeiIntent('356938035643809 unlock')).toBeNull();
    expect(imeiIntent('')).toBeNull();
  });

  it('runs the Luhn check', () => {
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
  });
});
