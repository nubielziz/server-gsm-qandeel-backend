// Decision 063: the position of a service is on the row of the four service routes (optional in the contract until the console reads it,
// like the keys of decision 060 were), and the two routes of the price grid and the stored order are built as the design says.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { describeListQuery } from '@src/common/contract';
import { listServicePriceGrid, orderServices } from '@src/modules/catalog/contracts/service-grid.contracts';
import {
  createService,
  listServices,
  showService,
  updateService,
} from '@src/modules/catalog/contracts/services.contracts';

/** The example answer of a route, as one row. */
const exampleRow = (route: { examples?: { response?: unknown } }): Record<string, unknown> => {
  const example = route.examples?.response;
  return (Array.isArray(example) ? example[0] : example) as Record<string, unknown>;
};

describe('the position of a service on the service rows', () => {
  it('is in the example of the list, show, POST and PATCH answers, stays optional, and is bounded', () => {
    for (const route of [listServices, showService, createService, updateService]) {
      const schema = route.success.schema as z.ZodType;
      const row = exampleRow(route);
      expect(row, route.key).toHaveProperty('sort');
      const without = Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'sort'));
      expect(schema.safeParse(without).success, `${route.key} without sort`).toBe(true);
      expect(schema.safeParse({ ...row, sort: 1_000_000 }).success, route.key).toBe(true);
      for (const bad of [-1, 1.5, 1_000_001])
        expect(schema.safeParse({ ...row, sort: bad }).success, route.key).toBe(false);
    }
  });

  it('is a sort of the list and of the grid, and the list keeps the name as its default', () => {
    const list = describeListQuery(listServices.query);
    expect(list.sorts).toContain('sort');
    expect(list.defaultSort).toEqual([{ field: 'name', order: 'asc' }]);
    const grid = describeListQuery(listServicePriceGrid.query);
    expect(grid.sorts).toEqual(['name', 'sort', 'id']);
    expect(Object.keys(grid.filters)).toEqual(['type', 'status', 'categoryId']);
    expect(listServices.description).toContain('`sort`');
  });
});

describe('the price grid and the order routes', () => {
  it('takes catalog:read for the grid (pricing:read is asked of the caller in the use case) and catalog:update for the order', () => {
    expect(listServicePriceGrid.permission).toBe('catalog:read');
    expect(listServicePriceGrid.description).toContain('pricing:read');
    expect(orderServices.permission).toBe('catalog:update');
  });

  it('answers a grid row that parses, with the margins signed and the cost nullable', () => {
    const schema = listServicePriceGrid.success.schema as z.ZodType;
    const row = exampleRow(listServicePriceGrid);
    expect(schema.safeParse(row).success).toBe(true);
    const negative = { ...row, baseMargin: '-1.0000', retailMargin: '-0.5000', cost: null, costChangedFrom: null };
    expect(schema.safeParse(negative).success).toBe(true);
    // One word for one fact: the grid says `manual` for a typed shop price, as the service rows do.
    expect(schema.safeParse({ ...row, retailPriceSource: 'typed' }).success).toBe(false);
    expect(schema.safeParse({ ...row, retailPriceSource: 'manual', retailPrice: null }).success).toBe(true);
    const { groupPrices: _left, ...without } = row;
    expect(schema.safeParse(without).success).toBe(false);
  });

  it('takes 1 to 500 items of an id and a position from 0 to 1000000', () => {
    const body = orderServices.body as z.ZodType;
    const item = (id: number, sort: number) => ({ id, sort });
    expect(body.safeParse({ items: [item(1, 0)] }).success).toBe(true);
    expect(body.safeParse({ items: Array.from({ length: 500 }, (_, index) => item(index + 1, 1)) }).success).toBe(true);
    expect(body.safeParse({ items: Array.from({ length: 501 }, (_, index) => item(index + 1, 1)) }).success).toBe(
      false,
    );
    expect(body.safeParse({ items: [] }).success).toBe(false);
    for (const bad of [item(0, 1), item(1, -1), item(1, 1_000_001), { id: 1, sort: 1.5 }, { id: 1 }]) {
      expect(body.safeParse({ items: [bad] }).success).toBe(false);
    }
    expect(orderServices.success.schema.safeParse({ updated: 2 }).success).toBe(true);
  });
});
