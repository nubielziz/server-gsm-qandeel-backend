// Unit tests of the IMEI masks (feature 18).
import { describe, expect, it } from 'bun:test';
import { erasedMainInput, maskedImei } from './imei-mask';

describe('maskedImei', () => {
  it('is the TAC followed by bullets up to 15 characters, or 15 bullets without a TAC', () => {
    expect(maskedImei('35389011')).toBe('35389011•••••••');
    expect(maskedImei('35389011')).toHaveLength(15);
    expect(maskedImei(null)).toBe('•'.repeat(15));
  });
});

describe('erasedMainInput', () => {
  it('cuts an IMEI to its TAC and a mask, with spaces and dashes ignored', () => {
    expect(erasedMainInput('353890113898412')).toBe('35389011•••••••');
    expect(erasedMainInput('35 389011-3898412')).toBe('35389011•••••••');
  });

  it('erases an input that is not an IMEI and keeps an empty or missing one', () => {
    expect(erasedMainInput('SN-ABC123')).toBeNull();
    expect(erasedMainInput('')).toBe('');
    expect(erasedMainInput(null)).toBeNull();
  });
});
