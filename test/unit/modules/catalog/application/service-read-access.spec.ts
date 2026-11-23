// Unit tests of the one rule of decision 060 for what a caller may read of a service row and which list filters it may use.
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import {
  LISTING_FILTERS,
  assertListFiltersAllowed,
  serviceReadAccess,
} from '@src/modules/catalog/application/service-read-access';
import { ATTENTION_REASONS } from '@src/modules/catalog/domain/service-attention';

const filter = (field: string) => ({ field, op: 'eq' as const, values: [true] });

describe('serviceReadAccess', () => {
  it('gives an Owner everything', () => {
    expect(serviceReadAccess({ permissions: ['*'] })).toEqual({
      listing: true,
      pricing: true,
      reasons: [...ATTENTION_REASONS],
    });
  });

  it('gives a catalog reader the supplier and floor reasons only', () => {
    expect(serviceReadAccess({ permissions: ['catalog:read', 'pricing:update'] })).toEqual({
      listing: false,
      pricing: false,
      reasons: ['no_supplier', 'below_floor'],
    });
  });

  it('opens the proposal with pricing:read and the shop page facts with storefront:read, an area wildcard included', () => {
    expect(serviceReadAccess({ permissions: ['catalog:read', 'pricing:read'] })).toEqual({
      listing: false,
      pricing: true,
      reasons: ['no_supplier', 'below_floor', 'price_proposal'],
    });
    expect(serviceReadAccess({ permissions: ['catalog:read', 'storefront:*'] })).toEqual({
      listing: true,
      pricing: false,
      reasons: ['no_supplier', 'below_floor', 'publish_failed'],
    });
  });
});

describe('assertListFiltersAllowed', () => {
  it('refuses isListed and notOnShop without storefront:read, naming the permission', () => {
    const access = serviceReadAccess({ permissions: ['catalog:read', 'pricing:read'] });
    for (const field of LISTING_FILTERS) {
      let refusal: unknown;
      try {
        assertListFiltersAllowed(access, { filters: [filter('needsAttention'), filter(field)] });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(AppError);
      expect((refusal as AppError).code).toBe('FORBIDDEN');
      expect((refusal as AppError).message).toContain('storefront:read');
    }
  });

  it('lets every other filter through, and every filter with storefront:read', () => {
    const plain = serviceReadAccess({ permissions: ['catalog:read'] });
    expect(() =>
      assertListFiltersAllowed(plain, {
        filters: ['needsAttention', 'hasSupplier', 'supplierId', 'belowFloor'].map(filter),
      }),
    ).not.toThrow();
    const shop = serviceReadAccess({ permissions: ['catalog:read', 'storefront:read'] });
    expect(() => assertListFiltersAllowed(shop, { filters: LISTING_FILTERS.map(filter) })).not.toThrow();
  });
});
