// Unit tests of the supplier's main box (decision 042): when `CUSTOM` names a box other than an IMEI, and how its label, lengths and
// the supplier's own pattern is ignored. The entries are written for these tests (no supplier's real data).
import { describe, expect, it } from 'bun:test';
import { supplierMainInput } from './supplier-main-input';

const entry = (custom: unknown): Record<string, unknown> => ({ SERVICEID: '1', SERVICENAME: 'Sample', CUSTOM: custom });

describe('supplierMainInput', () => {
  it('reads an ECID box with its lengths', () => {
    expect(
      supplierMainInput(entry({ allow: '1', customname: 'ECID', customlen: '13', maxlength: '16', regex: '' })),
    ).toEqual({
      label: 'ECID',
      minLength: 13,
      maxLength: 16,
    });
  });

  it('accepts allow as "1", 1 or true and nothing else', () => {
    for (const allow of ['1', 1, true, ' 1 ']) {
      expect(supplierMainInput(entry({ allow, customname: 'SN' })), String(allow)).not.toBeNull();
    }
    for (const allow of ['0', 0, false, 'yes', '', undefined, null, 2]) {
      expect(supplierMainInput(entry({ allow, customname: 'SN' })), String(allow)).toBeNull();
    }
  });

  it("answers null for a name that only says IMEI, and reads 'SN OR IMEI' as a box of its own", () => {
    for (const customname of ['IMEI', 'imei', 'IMEI No.', 'Imei Number', 'I-M-E-I']) {
      expect(supplierMainInput(entry({ allow: '1', customname })), customname).toBeNull();
    }
    expect(supplierMainInput(entry({ allow: '1', customname: 'SN OR IMEI' }))).toMatchObject({ label: 'SN OR IMEI' });
    expect(supplierMainInput(entry({ allow: '1', customname: 'IMEI 2' }))).toMatchObject({ label: 'IMEI 2' });
  });

  it('answers null without CUSTOM, for a CUSTOM that is not an object, or without a name', () => {
    expect(supplierMainInput({ SERVICEID: '1' })).toBeNull();
    expect(supplierMainInput(null)).toBeNull();
    expect(supplierMainInput('text')).toBeNull();
    for (const custom of [null, 'ECID', ['ECID'], 1]) expect(supplierMainInput(entry(custom))).toBeNull();
    for (const customname of [undefined, '', '   ', 7]) {
      expect(supplierMainInput(entry({ allow: '1', customname }))).toBeNull();
    }
  });

  it('collapses the spaces of the label and keeps at most 120 characters', () => {
    expect(supplierMainInput(entry({ allow: '1', customname: '  Serial \t Number\n ' }))?.label).toBe('Serial Number');
    expect(supplierMainInput(entry({ allow: '1', customname: 'x'.repeat(200) }))?.label).toHaveLength(120);
  });

  it('keeps maxlength from 1 to 500 and customlen from 1 to the maximum, else falls back', () => {
    const read = (customlen: unknown, maxlength: unknown) =>
      supplierMainInput(entry({ allow: '1', customname: 'SN', customlen, maxlength }));
    expect(read(5, 10)).toMatchObject({ minLength: 5, maxLength: 10 });
    expect(read('10', '10')).toMatchObject({ minLength: 10, maxLength: 10 });
    expect(read('11', '10')).toMatchObject({ minLength: 1, maxLength: 10 });
    expect(read('0', '0')).toMatchObject({ minLength: 1, maxLength: null });
    expect(read('4', '501')).toMatchObject({ minLength: 4, maxLength: null });
    expect(read('2.5', '12.5')).toMatchObject({ minLength: 1, maxLength: null });
    expect(read('-3', 'abc')).toMatchObject({ minLength: 1, maxLength: null });
    expect(read(undefined, undefined)).toMatchObject({ minLength: 1, maxLength: null });
  });

  it("never reads the supplier's own regex, wrapped or not, broken or catastrophic", () => {
    for (const regex of [
      '^[0-9A-F]{12}$',
      '/^[0-9a-f]{12}$/i',
      '\\A\\d+\\z',
      '[[:alnum:]]+',
      '^(\\w+\\s?)+$',
      '^[0-9',
    ]) {
      const main = supplierMainInput(entry({ allow: '1', customname: 'SN', maxlength: '12', regex }));
      expect(main, regex).toEqual({ label: 'SN', minLength: 1, maxLength: 12 });
    }
  });
});
