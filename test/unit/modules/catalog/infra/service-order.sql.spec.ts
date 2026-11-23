// Unit tests of the sort keys a list expands (decision 063): `category` of the merchant lists and `sort` of the admin list stand for
// several keys, all in the direction the caller asked for, and a key the caller sent itself is kept as it is.
import { describe, expect, it } from 'bun:test';
import { expandSortField } from '@src/modules/catalog/infra/service-order.sql';

const asc = (field: string) => ({ field, order: 'asc' as const });
const desc = (field: string) => ({ field, order: 'desc' as const });

describe('expandSortField', () => {
  it('puts the service position after the category, in the direction of the category', () => {
    expect(expandSortField([asc('category'), asc('name')], 'category', { after: ['position'] })).toEqual([
      asc('category'),
      asc('position'),
      asc('name'),
    ]);
    expect(expandSortField([desc('category')], 'category', { after: ['position'] })).toEqual([
      desc('category'),
      desc('position'),
    ]);
  });

  it('puts the category position before `sort` and the name after it, in the direction asked', () => {
    const around = { before: ['categoryPosition'], after: ['name'] };
    expect(expandSortField([asc('sort')], 'sort', around)).toEqual([asc('categoryPosition'), asc('sort'), asc('name')]);
    expect(expandSortField([desc('sort')], 'sort', around)).toEqual([
      desc('categoryPosition'),
      desc('sort'),
      desc('name'),
    ]);
  });

  it('keeps a name the caller sent, with the direction the caller gave it', () => {
    const around = { before: ['categoryPosition'], after: ['name'] };
    expect(expandSortField([asc('sort'), desc('name')], 'sort', around)).toEqual([
      asc('categoryPosition'),
      asc('sort'),
      desc('name'),
    ]);
  });

  it('leaves a sort that does not name the field as it is', () => {
    const sort = [desc('name'), asc('id')];
    expect(expandSortField(sort, 'sort', { before: ['categoryPosition'], after: ['name'] })).toEqual(sort);
  });
});
