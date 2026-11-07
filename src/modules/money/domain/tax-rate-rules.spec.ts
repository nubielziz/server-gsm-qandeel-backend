// Unit tests of the tax rate rules: field checks and the window overlap rule.
import { describe, expect, it } from 'bun:test';
import {
  checkCountry,
  checkRatePercent,
  checkTaxText,
  checkTaxType,
  checkWindow,
  windowsOverlap,
} from './tax-rate-rules';

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

describe('tax rate field checks', () => {
  it('accepts two capital letters as a country and refuses the rest', () => {
    expect(checkCountry('FR')).toBeUndefined();
    for (const bad of ['fr', 'FRA', 'F', '', 'F1']) expect(checkCountry(bad)?.field).toBe('country');
  });

  it('accepts rates from 0 to 100 with up to four decimals', () => {
    for (const good of ['0', '20', '20.5', '19.6000', '100', '7.75']) expect(checkRatePercent(good)).toBeUndefined();
    for (const bad of ['-1', '100.01', '101', '20.12345', 'abc', '', '1e2']) {
      expect(checkRatePercent(bad)?.field).toBe('ratePercent');
    }
  });

  it('knows the console tax types', () => {
    for (const good of ['vat', 'gst', 'sales_tax', 'none']) expect(checkTaxType(good)).toBeUndefined();
    expect(checkTaxType('VAT')?.field).toBe('taxType');
    expect(checkTaxType('')?.field).toBe('taxType');
  });

  it('limits the free texts', () => {
    expect(checkTaxText('label', 'x'.repeat(80))).toBeUndefined();
    expect(checkTaxText('label', 'x'.repeat(81))).toMatchObject({ field: 'label', code: 'max' });
    expect(checkTaxText('ossScheme', 'x'.repeat(41))?.field).toBe('ossScheme');
  });

  it('wants an end after the start, or no end', () => {
    expect(checkWindow(day('2026-01-01'), null)).toBeUndefined();
    expect(checkWindow(day('2026-01-01'), day('2026-07-01'))).toBeUndefined();
    expect(checkWindow(day('2026-01-01'), day('2026-01-01'))?.field).toBe('validTo');
    expect(checkWindow(day('2026-01-01'), day('2025-12-31'))?.field).toBe('validTo');
  });
});

describe('windowsOverlap', () => {
  it('treats the end as exclusive, so a rate can follow another on the same day', () => {
    const first = { from: day('2026-01-01'), to: day('2026-07-01') };
    expect(windowsOverlap(first, { from: day('2026-07-01'), to: null })).toBe(false);
    expect(windowsOverlap(first, { from: day('2026-06-30'), to: null })).toBe(true);
  });

  it('treats a missing end as open, on either side', () => {
    expect(windowsOverlap({ from: day('2026-01-01'), to: null }, { from: day('2030-01-01'), to: null })).toBe(true);
    expect(
      windowsOverlap({ from: day('2026-01-01'), to: null }, { from: day('2020-01-01'), to: day('2026-01-01') }),
    ).toBe(false);
    expect(
      windowsOverlap({ from: day('2020-01-01'), to: day('2021-01-01') }, { from: day('2026-01-01'), to: null }),
    ).toBe(false);
  });

  it('finds a window inside another', () => {
    expect(
      windowsOverlap(
        { from: day('2026-01-01'), to: day('2027-01-01') },
        { from: day('2026-03-01'), to: day('2026-04-01') },
      ),
    ).toBe(true);
  });
});
