// Unit tests of the import contracts of the suppliers module (decision 063, B242): the two optional keys of the import and its preview, and the
// two optional fields of a preview item. Without the keys nothing about the body or the answer changes.
import { describe, expect, it } from 'bun:test';
import { importServices, previewImport } from '@src/modules/suppliers/contracts/suppliers.contracts';

describe.each([
  ['POST /admin/suppliers/:id/import', importServices],
  ['POST /admin/suppliers/:id/import/preview', previewImport],
])('the body of %s', (_key, route) => {
  const parse = (body: unknown) => route.body.safeParse(body);

  it('stays what it was without the new keys: the parsed body has neither', () => {
    const parsed = parse({ supplierServiceIds: [91, 92] });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ supplierServiceIds: [91, 92] });
    expect(Object.keys(parsed.data ?? {})).toEqual(['supplierServiceIds']);
  });

  it('takes status active or disabled, and a category id', () => {
    expect(parse({ supplierServiceIds: [91], status: 'disabled', categoryId: 7 }).data).toEqual({
      supplierServiceIds: [91],
      status: 'disabled',
      categoryId: 7,
    });
    expect(parse({ supplierServiceIds: [91], status: 'active' }).data).toEqual({
      supplierServiceIds: [91],
      status: 'active',
    });
  });

  it('refuses any other status and a category id that is not a positive whole number', () => {
    for (const status of ['paused', 'archived', 'Active', '', null, 1]) {
      expect(parse({ supplierServiceIds: [91], status }).success).toBe(false);
    }
    for (const categoryId of [0, -3, 1.5, '7', null]) {
      expect(parse({ supplierServiceIds: [91], categoryId }).success).toBe(false);
    }
  });

  it('still needs one to 500 picked services', () => {
    expect(parse({ status: 'disabled' }).success).toBe(false);
    expect(parse({ supplierServiceIds: [], status: 'disabled' }).success).toBe(false);
    expect(parse({ supplierServiceIds: Array.from({ length: 501 }, (_, index) => index + 1) }).success).toBe(false);
  });
});

describe('the answer of the preview', () => {
  const item = {
    supplierServiceId: 91,
    name: 'Chimera 1 month',
    type: 'SERVER',
    state: 'new' as const,
    serviceId: null,
    serviceName: null,
    cost: '19.8000',
    previousCost: null,
    suggestedPrice: '20.9900',
    minQty: 1,
    maxQty: 1,
    qtyOptions: [],
    quantityDiffers: false,
  };
  const answer = (extra: object) => previewImport.success.schema.safeParse({ items: [{ ...item, ...extra }] });

  it('is byte for byte the old item when the preview carries neither new field', () => {
    const parsed = answer({});
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ items: [item] });
    expect(JSON.stringify(parsed.data)).toBe(JSON.stringify({ items: [item] }));
  });

  it('keeps the status and the category of an item when the preview says them, null for an item nothing creates', () => {
    expect(answer({ status: 'disabled', category: { id: 7, name: 'Carrier unlock' } }).data).toEqual({
      items: [{ ...item, status: 'disabled', category: { id: 7, name: 'Carrier unlock' } }],
    });
    expect(answer({ status: null, category: null }).data).toEqual({
      items: [{ ...item, status: null, category: null }],
    });
    expect(answer({ status: 'paused' }).success).toBe(false);
    expect(answer({ category: { id: 0, name: 'x' } }).success).toBe(false);
  });

  it('names a category the import would make with its name and a null id', () => {
    expect(answer({ status: 'active', category: { id: null, name: 'Carrier unlock' } }).data).toEqual({
      items: [{ ...item, status: 'active', category: { id: null, name: 'Carrier unlock' } }],
    });
    expect(answer({ status: 'active', category: { id: null } }).success).toBe(false);
  });
});
