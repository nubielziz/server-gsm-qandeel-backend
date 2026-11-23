// Decision 060: the keys of a service row that depend on the reader's permissions are left out for some readers, so the four routes
// that answer a row keep them optional for good (a required key left out would be a 500); the read of a service's supplier chain
// answers the shape the PUT answers.
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

/** The keys only some readers get: the rule and the proposal (pricing:read), the shop page facts (storefront:read). */
const PERMISSION_KEYS = [
  'retailPriceRule',
  'retailPriceWaiting',
  'listingId',
  'isListed',
  'shopBlocked',
  'publishFailure',
];

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

  it('answers the supplier chain of one service as the PUT does', () => {
    expect(z.toJSONSchema(showServiceSupplierLinks.success.schema)).toEqual(
      z.toJSONSchema(replaceSupplierLinks.success.schema),
    );
    expect(showServiceSupplierLinks.permission).toBe('catalog:read');
  });
});
