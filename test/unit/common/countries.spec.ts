// Unit tests of the static country list (decision 079, the review's B1): its size, a few members and the codes it must refuse.
import { describe, expect, it } from 'bun:test';
import { COUNTRY_CODES, isCountryCode } from '@src/common/countries';

describe('COUNTRY_CODES', () => {
  it('holds the 249 officially assigned ISO 3166-1 alpha-2 codes and XK, once each, in code order', () => {
    expect(COUNTRY_CODES).toHaveLength(250);
    expect(new Set(COUNTRY_CODES).size).toBe(250);
    expect([...COUNTRY_CODES]).toEqual([...COUNTRY_CODES].sort());
    for (const code of ['AD', 'GB', 'JO', 'PS', 'US', 'XK', 'ZW']) expect(COUNTRY_CODES).toContain(code as never);
  });

  it('accepts a listed code in any case', () => {
    expect(isCountryCode('GB')).toBe(true);
    expect(isCountryCode('jo')).toBe(true);
    expect(isCountryCode('Xk')).toBe(true);
  });

  it('refuses the codes Intl.DisplayNames names but no country has, and anything that is not a listed code', () => {
    for (const code of ['UK', 'EU', 'UN', 'SU', 'AC', 'IC', 'QO', 'ZZ', 'GBR', 'G', '', '12']) {
      expect(isCountryCode(code), code).toBe(false);
    }
  });
});
