// Decision 060: the keys of a service row that depend on the reader's permissions are left out for some readers, so the four routes
// that answer a row keep them optional for good (a required key left out would be a 500). The keys every reader gets (`attention`,
// `retailPrice`, `retailPriceSource`, and the merchant switches since decision 063; `createdServiceIds` on the answer of an import)
// are required. The read of a service's supplier chain answers the shape the PUT answers.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  createService,
  listServices,
  showService,
  updateService,
} from '@src/modules/catalog/contracts/services.contracts';
import {
  replaceSupplierLinks,
  showServiceSupplierLinks,
} from '@src/modules/suppliers/contracts/supplier-links-logs.contracts';
import { importServices } from '@src/modules/suppliers/contracts/suppliers.contracts';

/** The keys only some readers get: the rule and the proposal (pricing:read), the shop page facts (storefront:read). */
const PERMISSION_KEYS = [
  'retailPriceRule',
  'retailPriceWaiting',
  'listingId',
  'isListed',
  'shopBlocked',
  'publishFailure',
];

/** The keys every reader of a service row gets, whatever its permissions (the merchant switches since the console reads them). */
const ALWAYS_KEYS = ['attention', 'retailPrice', 'retailPriceSource', 'allowCancel', 'allowVerify', 'verifyWindowH'];

/** The example answer of a route, as one row. */
const exampleRow = (route: { examples?: { response?: unknown } }): Record<string, unknown> => {
  const example = route.examples?.response;
  return (Array.isArray(example) ? example[0] : example) as Record<string, unknown>;
};

describe('the service row of decision 060', () => {
  it('parses the row of the list, show, POST and PATCH answers with and without the keys that depend on the reader', () => {
    for (const route of [listServices, showService, createService, updateService]) {
      const example = route.examples?.response;
      const row = (Array.isArray(example) ? example[0] : example) as Record<string, unknown>;
      const schema = route.success.schema as z.ZodType;
      expect(schema.safeParse(row).success, route.key).toBe(true);
      for (const key of ['listingId', 'isListed', 'shopBlocked', 'retailPriceRule', 'retailPriceWaiting']) {
        expect(row, `${route.key} example`).toHaveProperty(key);
      }
      const plain = Object.fromEntries(Object.entries(row).filter(([key]) => !PERMISSION_KEYS.includes(key)));
      expect(schema.safeParse(plain).success, route.key).toBe(true);
    }
  });

  it('requires attention, retailPrice, retailPriceSource and the merchant switches on the four routes, and leaves every permission key optional', () => {
    for (const route of [listServices, showService, createService, updateService]) {
      const schema = route.success.schema as z.ZodType;
      const row = exampleRow(route);
      for (const key of ALWAYS_KEYS) {
        expect(row, `${route.key} example`).toHaveProperty(key);
        const without = Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
        expect(schema.safeParse(without).success, `${route.key} without ${key}`).toBe(false);
      }
      // A typed price, a missing one and the empty list are values, not omissions: the keys stay present.
      expect(
        schema.safeParse({ ...row, attention: [], retailPrice: null, retailPriceSource: null }).success,
        route.key,
      ).toBe(true);
      // The keys that depend on the reader are left out for some readers, so a row without them is still a row.
      const plain = Object.fromEntries(Object.entries(row).filter(([name]) => !PERMISSION_KEYS.includes(name)));
      expect(schema.safeParse(plain).success, `${route.key} without the permission keys`).toBe(true);
    }
  });

  it('requires createdServiceIds on the answer of an import, an empty list when nothing was created', () => {
    const schema = importServices.success.schema as z.ZodType;
    const answer = importServices.examples?.response as Record<string, unknown>;
    expect(schema.safeParse(answer).success).toBe(true);
    expect(schema.safeParse({ created: 0, updated: 1, unchanged: 0, createdServiceIds: [] }).success).toBe(true);
    const { createdServiceIds: _left, ...without } = answer;
    expect(schema.safeParse(without).success).toBe(false);
  });

  it('answers the supplier chain of one service as the PUT does', () => {
    expect(z.toJSONSchema(showServiceSupplierLinks.success.schema)).toEqual(
      z.toJSONSchema(replaceSupplierLinks.success.schema),
    );
    expect(showServiceSupplierLinks.permission).toBe('catalog:read');
  });
});
