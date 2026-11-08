// Tests of the listing rules: the lock reasons of B53 and the retail price against its floor (catalog-12, b2c-7).
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { dollars } from '../../catalog';
import { belowStorefrontFloorMessage, lockOf, lockedDetail, retailPriceProblem } from './listing-rules';

const open = { serviceStatus: 'active', categoryName: 'Apple', categoryAllowedGroupIds: [], retailGroupId: 2 };

describe('lockOf', () => {
  it('leaves an active service in a category open to every group unlocked', () => {
    expect(lockOf(open)).toEqual({ locked: false, reason: null });
  });

  it('leaves a category that lists the retail group unlocked', () => {
    expect(lockOf({ ...open, categoryAllowedGroupIds: [1, 2] }).locked).toBe(false);
  });

  it('locks a category that excludes the retail group as B2B only', () => {
    expect(lockOf({ ...open, categoryAllowedGroupIds: [1, 3] })).toEqual({
      locked: true,
      reason: 'B2B only: the category Apple is not offered to storefront customers',
    });
  });

  it('locks a category with a group list when there is no retail group at all', () => {
    expect(lockOf({ ...open, categoryAllowedGroupIds: [1], retailGroupId: undefined }).locked).toBe(true);
  });

  it('locks a service that is not active', () => {
    expect(lockOf({ ...open, serviceStatus: 'disabled' })).toEqual({ locked: true, reason: 'Service disabled' });
  });

  it('reports the category before the status when both apply', () => {
    expect(lockOf({ ...open, serviceStatus: 'disabled', categoryAllowedGroupIds: [1] }).reason).toMatch(/^B2B only/);
  });
});

describe('lockedDetail', () => {
  it('adds the refusal sentence the console shows', () => {
    expect(lockedDetail('Service disabled')).toBe('Service disabled. This service cannot be listed publicly.');
  });
});

describe('retailPriceProblem', () => {
  const floor = Money.of('19.0100');

  it('accepts a price at or above the floor', () => {
    expect(retailPriceProblem(Money.of('19.0100'), floor)).toBeNull();
    expect(retailPriceProblem(Money.of('25.9900'), floor)).toBeNull();
  });

  it('refuses a price under the floor and names it', () => {
    expect(retailPriceProblem(Money.of('19.0099'), floor)).toBe('Below the storefront floor of $19.01.');
  });

  it('refuses a price that is not above zero before looking at the floor', () => {
    expect(retailPriceProblem(Money.of('0.0000'), floor)).toBe('Enter a price greater than zero.');
  });

  it('writes the floor with at least two and at most four decimals', () => {
    expect(belowStorefrontFloorMessage(Money.of('2.5000'))).toBe('Below the storefront floor of $2.50.');
    expect(belowStorefrontFloorMessage(Money.of('0.1425'))).toBe('Below the storefront floor of $0.1425.');
  });

  it("uses catalog's dollars() for the amount, as the group-prices route does", () => {
    for (const text of ['19.0100', '0.1400', '1234.5000', '0.0825']) {
      const floor = Money.of(text);
      expect(belowStorefrontFloorMessage(floor)).toBe(`Below the storefront floor of ${dollars(floor)}.`);
    }
  });
});
