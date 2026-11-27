// Unit tests of the IMEIs a storefront checkout asks the blocklist about (RULES risk 5; decisions 073 and 076): at the open
// (`blockableImeisOf`) and at the payment (`mainInputImeisOf`, every IMEI of a main input that is a list).
import { describe, expect, it } from 'bun:test';
import { type ImeiField, blockableImeisOf, mainInputImeisOf } from '@src/modules/customers/domain/checkout-imeis';

const A = '353890110000004';
const B = '352905112490861';
const C = '354607111076240';

const box = (fieldType: ImeiField['fieldType']): ImeiField => ({ key: 'imeis', fieldType, isMainInput: true });

describe('blockableImeisOf', () => {
  it('reads the main input, every imei field and each line of every imei_bulk field, valid IMEIs only, without repeats', () => {
    const fields = [
      { key: 'device', fieldType: 'imei' as const },
      { key: 'others', fieldType: 'imei_bulk' as const },
      { key: 'note', fieldType: 'text' as const },
    ];
    expect(
      blockableImeisOf(`${A.slice(0, 5)} ${A.slice(5)}`, fields, { device: B, others: `${C}\n${A}\n123`, note: C }),
    ).toEqual([A, B, C]);
    expect(blockableImeisOf('F2LXK0ABCD12', fields, {})).toEqual([]);
  });
});

describe('mainInputImeisOf', () => {
  it('reads every IMEI of a main input whose field is a list', () => {
    expect(mainInputImeisOf(`${A}\n${B}\n${C}`, [box('imei_bulk')])).toEqual([A, B, C]);
  });

  it('reads one IMEI of a main input that is one IMEI, whatever the type of its field', () => {
    expect(mainInputImeisOf(A, [box('imei')])).toEqual([A]);
    expect(mainInputImeisOf(A, [box('text')])).toEqual([A]);
    expect(mainInputImeisOf(A, [])).toEqual([A]);
  });

  it('reads no IMEI from a main input that is not one, or from none', () => {
    // A text main input with line breaks is not a list: it is one value, as the open reads it.
    expect(mainInputImeisOf(`${A}\n${B}`, [box('textarea')])).toEqual([]);
    expect(mainInputImeisOf('F2LXK0ABCD12', [box('serial')])).toEqual([]);
    expect(mainInputImeisOf(undefined, [box('imei_bulk')])).toEqual([]);
  });

  it('asks the blocklist about the IMEIs the open asked about for the same main input', () => {
    const list = `${A}\n${B}`;
    expect(mainInputImeisOf(list, [box('imei_bulk')])).toEqual(
      blockableImeisOf(list, [box('imei_bulk')], { imeis: list }),
    );
  });
});
