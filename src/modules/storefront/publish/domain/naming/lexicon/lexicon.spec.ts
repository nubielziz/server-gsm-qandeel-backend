// Tests of the naming lexicons (feature 31, plan section 3.5: "the lexicons are data files with tests"): their shape, the frozen
// tool list, and the patterns that carry a trap.
import { describe, expect, it } from 'bun:test';
import { IMPORTED_CATEGORY_NAME } from '../../../../../catalog';
import { APP_BRANDS, DEVICE_BRANDS } from './brands';
import { CARRIER_COUNTRIES, CARRIERS } from './carriers';
import { BARE_COUNTRY_CODES, COUNTRY_TRAPS, EXTRA_COUNTRY_WORDS, NOT_COUNTRY_CODES } from './countries';
import { KNOWN_TOOLS, NAME_BRAND_GROUPS, TOOL_ALIASES } from './tools';
import { CASING_FIXES, PROTECTED_WORDS, TYPO_FIXES } from './typos';

const ISO2 = /^[A-Z]{2}$/;
const brandOf = (list: typeof DEVICE_BRANDS, text: string) => list.filter(([, re]) => re.test(text)).map(([b]) => b);

describe('the tool list', () => {
  it('holds the 145 names the prototype learned from the 1157 real names, in its order, each once', () => {
    expect(KNOWN_TOOLS).toHaveLength(145);
    expect(new Set(KNOWN_TOOLS).size).toBe(145);
    expect(KNOWN_TOOLS[0]).toBe('360 TOOL');
    expect(KNOWN_TOOLS.slice(-3)).toEqual(['Chimera', 'TFM', 'Infinity']);
  });

  it('merges the groups of one tool through the aliases', () => {
    const alias = (text: string) => TOOL_ALIASES.find(([re]) => re.test(text))?.[1];
    expect(alias('Octopus, Octoplus')).toBe('Octoplus');
    expect(alias('Infinity Activation CM2')).toBe('Infinity CM2');
    expect(alias('Chimera Tool')).toBeUndefined();
    expect(NAME_BRAND_GROUPS.has('Share Box & Tools Software')).toBe(true);
  });

  it('never reads the name the catalog gives a group with no usable text as a brand', () => {
    expect(NAME_BRAND_GROUPS.has(IMPORTED_CATEGORY_NAME)).toBe(true);
  });
});

describe('the brands', () => {
  it('has one pattern per brand name within each list', () => {
    expect(new Set(DEVICE_BRANDS.map(([brand]) => brand)).size).toBe(DEVICE_BRANDS.length);
    expect(new Set(APP_BRANDS.map(([brand]) => brand)).size).toBe(APP_BRANDS.length);
  });

  it('keeps the traps in the patterns', () => {
    expect(brandOf(DEVICE_BRANDS, 'Kyocera Phone')).toEqual(['Kyocera']);
    expect(brandOf(DEVICE_BRANDS, 'Nothing Tool')).toEqual([]);
    expect(brandOf(DEVICE_BRANDS, 'Nothing Phone')).toEqual(['Nothing']);
    expect(brandOf(DEVICE_BRANDS, 'Knoxwizard')).toEqual([]);
    expect(brandOf(DEVICE_BRANDS, 'A12+ Bypass')).toEqual(['Apple']);
    expect(brandOf(DEVICE_BRANDS, 'A120 Router')).toEqual([]);
    expect(brandOf(DEVICE_BRANDS, 'Mi Account')).toEqual(['Xiaomi']);
  });
});

describe('the carriers', () => {
  it('gives every carrier a home country or marks it as working in several', () => {
    for (const carrier of CARRIERS) {
      expect(carrier.country === null ? carrier.multi : ISO2.test(carrier.country)).toBe(true);
    }
    expect(new Set(CARRIERS.map((carrier) => carrier.name)).size).toBe(CARRIERS.length);
  });

  it('lists the countries of carriers that work in several as ISO-2 codes', () => {
    for (const [name, codes] of Object.entries(CARRIER_COUNTRIES)) {
      expect(CARRIERS.some((carrier) => carrier.name === name && carrier.multi)).toBe(true);
      expect(codes.every((code) => ISO2.test(code))).toBe(true);
    }
  });

  it('reads EE only in capitals, Wind only before Canada and TIM only as Tim Brazil', () => {
    const named = (text: string) =>
      CARRIERS.filter((carrier) => carrier.pattern.test(text)).map((carrier) => carrier.name);
    expect(named('UK EE iPhone')).toEqual(['EE']);
    expect(named('free unlock')).toEqual([]);
    expect(named('Wind Canada')).toEqual(['Wind']);
    expect(named('wind turbine')).toEqual([]);
    expect(named('Tim Brazil')).toEqual(['TIM']);
  });
});

describe('the countries', () => {
  it('maps the extra words to ISO-2 codes and skips only withdrawn or grouping codes', () => {
    expect(EXTRA_COUNTRY_WORDS.every(([, code]) => ISO2.test(code))).toBe(true);
    expect([...NOT_COUNTRY_CODES].every((code) => ISO2.test(code))).toBe(true);
    expect(NOT_COUNTRY_CODES.has('DE')).toBe(false);
    expect(BARE_COUNTRY_CODES).toEqual(['US', 'UK', 'JP']);
  });

  it('blanks the phrases that hold a country word without naming a country', () => {
    const blank = (text: string) => COUNTRY_TRAPS.reduce((out, re) => out.replace(re, ' '), text).trim();
    expect(blank('CDMA YEMEN TOOL')).toBe('TOOL');
    expect(blank('SamsungTool.us Credits')).toBe('Credits');
  });
});

describe('the spellings', () => {
  it('holds patterns that a second pass leaves as they are', () => {
    const apply = (text: string) =>
      [...TYPO_FIXES, ...CASING_FIXES].reduce(
        (out, [re, to]) => (typeof to === 'string' ? out.replace(re, to) : out.replace(re, to)),
        text,
      );
    for (const text of ['Premimum Genric 1 Years', 'IPHONE ICLOUD At&t Frp', '3 Month Waranty']) {
      expect(apply(apply(text))).toBe(apply(text));
    }
    expect(apply('IPHONE ICLOUD At&t Frp')).toBe('iPhone iCloud AT&T FRP');
    expect(PROTECTED_WORDS.has('IMEI')).toBe(true);
  });
});
