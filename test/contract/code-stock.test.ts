// Decision 069: the service row of the four service routes carries `stockDelivery`, `stockAvailable` and `ownCost` (required: the console
// carries them), the list takes the filter `stockDelivery`, the create and change bodies take `stockDelivery` and `ownCost` (0 to
// 1,000,000,000), the import and the change describe their refusal, and a publish row may be blocked `out_of_stock`.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { importInventoryCodes } from '@src/modules/catalog/contracts/inventory.contracts';
import {
  createService,
  listServices,
  showService,
  updateService,
} from '@src/modules/catalog/contracts/services.contracts';
import { PUBLISH_BLOCK_REASONS } from '@src/modules/storefront/db/schema';

const ROW_KEYS = ['stockDelivery', 'stockAvailable', 'ownCost'];

/** The example answer of a route, as one row. */
const exampleRow = (route: { examples?: { response?: unknown } }): Record<string, unknown> => {
  const example = route.examples?.response;
  return (Array.isArray(example) ? example[0] : example) as Record<string, unknown>;
};

describe('the service row of decision 069', () => {
  it('is in the example of the list, show, POST and PATCH answers, is required, and holds a count and a money string', () => {
    for (const route of [listServices, showService, createService, updateService]) {
      const schema = route.success.schema as z.ZodType;
      const row = exampleRow(route);
      for (const key of ROW_KEYS) expect(row, `${route.key} example`).toHaveProperty(key);
      for (const key of ROW_KEYS) {
        const without = Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
        expect(schema.safeParse(without).success, `${route.key} without ${key}`).toBe(false);
      }
      expect(schema.safeParse({ ...row, stockDelivery: true, stockAvailable: 12, ownCost: '4.7000' }).success).toBe(
        true,
      );
      for (const bad of [{ stockAvailable: -1 }, { stockAvailable: 1.5 }, { ownCost: 4.7 }, { stockDelivery: 'yes' }]) {
        expect(schema.safeParse({ ...row, ...bad }).success, `${route.key} ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });
});

describe('the create and change bodies', () => {
  const create = {
    name: 'iTunes 10 USD',
    code: 'GC-ITUNES-10',
    categoryId: 9,
    type: 'server',
    slaMinutes: 5,
    basePrice: '10.9900',
  };

  it('take stockDelivery and a non-negative ownCost, both optional', () => {
    const post = createService.body as z.ZodType;
    const patch = updateService.body as z.ZodType;
    expect(post.safeParse(create).success).toBe(true);
    expect(post.safeParse({ ...create, stockDelivery: true, ownCost: '4.7000' }).success).toBe(true);
    expect(post.safeParse({ ...create, ownCost: '0.0000' }).success).toBe(true);
    expect(post.safeParse({ ...create, ownCost: '-0.0100' }).success).toBe(false);
    expect(patch.safeParse({ stockDelivery: false }).success).toBe(true);
    expect(patch.safeParse({ ownCost: '4.7000' }).success).toBe(true);
    expect(patch.safeParse({ ownCost: '-1.0000' }).success).toBe(false);
  });

  it('cap ownCost at 1000000000.0000, like a supplier price (decision 051)', () => {
    const post = createService.body as z.ZodType;
    const patch = updateService.body as z.ZodType;
    for (const schema of [post, patch]) {
      const base = schema === post ? create : {};
      expect(schema.safeParse({ ...base, ownCost: '1000000000.0000' }).success).toBe(true);
      expect(schema.safeParse({ ...base, ownCost: '1000000000.0001' }).success).toBe(false);
      expect(schema.safeParse({ ...base, ownCost: '99999999999999.9999' }).success).toBe(false);
    }
  });

  it('describe the refusals and the permission of the own cost', () => {
    expect(updateService.description).toContain('codes_in_stock');
    expect(updateService.description).toContain('pricing:update');
    expect(importInventoryCodes.description).toContain('not_stock_service');
    expect(importInventoryCodes.errors).toContain('VALIDATION_FAILED');
  });
});

describe('the list filter', () => {
  it('takes stockDelivery=true|false', () => {
    const query = listServices.query as z.ZodType;
    expect(query.safeParse({ stockDelivery: 'true' }).success).toBe(true);
    expect(query.safeParse({ stockDelivery: 'false' }).success).toBe(true);
    expect(query.safeParse({ stockDelivery: 'yes' }).success).toBe(false);
    expect(listServices.description).toContain('`stockDelivery`');
  });
});

describe('the publish block reasons', () => {
  it('hold out_of_stock right after supplier_unavailable', () => {
    const reasons: readonly string[] = PUBLISH_BLOCK_REASONS;
    expect(reasons.indexOf('out_of_stock')).toBe(reasons.indexOf('supplier_unavailable') + 1);
  });
});
