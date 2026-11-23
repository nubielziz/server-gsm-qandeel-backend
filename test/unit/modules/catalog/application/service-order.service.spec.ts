// Unit tests of the check of the stored order of services that needs no database (decision 063): a service listed twice.
import { describe, expect, it } from 'bun:test';
import { repeatedItems } from '@src/modules/catalog/application/service-order.service';

describe('repeatedItems', () => {
  it('flags the later of two items with the same service', () => {
    expect(
      repeatedItems([
        { id: 5, sort: 1 },
        { id: 6, sort: 2 },
        { id: 5, sort: 3 },
        { id: 6, sort: 4 },
        { id: 5, sort: 5 },
      ]),
    ).toEqual([2, 3, 4]);
  });

  it('flags nothing when every service is listed once', () => {
    expect(repeatedItems([])).toEqual([]);
    expect(
      repeatedItems([
        { id: 1, sort: 0 },
        { id: 2, sort: 0 },
      ]),
    ).toEqual([]);
  });
});
