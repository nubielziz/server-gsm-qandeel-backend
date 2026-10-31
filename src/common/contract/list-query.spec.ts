// Unit tests for listQuery (ALIGNMENT § 2): range, sort, search, filter operators, repeats, whitelists and extras.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { describeListQuery, isListQuerySchema, listQuery, listQueryParameters } from './list-query';

const staff = listQuery({
  sorts: ['name', 'createdAt', 'id'],
  defaultSort: { field: 'createdAt', order: 'desc' },
  filters: {
    status: { type: 'enum', values: ['active', 'invited', 'suspended'] },
    'role.id': { type: 'id' },
    name: { type: 'string' },
    createdAt: { type: 'datetime' },
    balance: { type: 'decimal' },
    twofaEnabled: { type: 'boolean' },
    age: { type: 'number', ops: ['gte', 'lte'] },
  },
  search: ['name', 'email'],
  extra: { open: z.stringbool().optional(), from: z.iso.date().optional() },
});

const ok = (query: Record<string, string | string[]>) => {
  const result = staff.safeParse(query);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
};
const fails = (query: Record<string, string | string[]>) => {
  const result = staff.safeParse(query);
  expect(result.success).toBe(false);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
        keys: 'keys' in issue ? issue.keys : undefined,
      }));
};

describe('range', () => {
  it('defaults to rows 0 to 25', () => {
    expect(ok({}).range).toEqual({ start: 0, end: 25, limit: 25 });
  });

  it('reads _start and _end', () => {
    expect(ok({ _start: '10', _end: '30' }).range).toEqual({ start: 10, end: 30, limit: 20 });
    expect(ok({ _start: '0', _end: '1' }).range).toEqual({ start: 0, end: 1, limit: 1 });
  });

  it('completes a lone _start or _end', () => {
    expect(ok({ _start: '50' }).range).toEqual({ start: 50, end: 75, limit: 25 });
    expect(ok({ _end: '10' }).range).toEqual({ start: 0, end: 10, limit: 10 });
  });

  it('allows a page of exactly 1000 and refuses 1001', () => {
    expect(ok({ _start: '0', _end: '1000' }).range.limit).toBe(1000);
    expect(fails({ _start: '0', _end: '1001' })).toEqual([expect.objectContaining({ path: '_end' })]);
  });

  it('names the bad parameter', () => {
    expect(fails({ _start: '-1' })[0]?.path).toBe('_start');
    expect(fails({ _start: 'abc' })[0]?.path).toBe('_start');
    expect(fails({ _end: '0' })[0]?.path).toBe('_end');
    expect(fails({ _start: '10', _end: '10' })[0]).toMatchObject({
      path: '_end',
      message: 'Must be greater than _start.',
    });
    expect(fails({ _start: ['1', '2'] })[0]?.path).toBe('_start');
    expect(fails({ _start: '99999999999' })[0]?.path).toBe('_start');
  });

  it('honours a smaller maxPage', () => {
    const small = listQuery({ sorts: ['id'], defaultSort: { field: 'id', order: 'asc' }, maxPage: 50 });
    expect(small.safeParse({ _start: '0', _end: '51' }).success).toBe(false);
    expect(small.safeParse({ _start: '0', _end: '50' }).success).toBe(true);
  });
});

describe('sort', () => {
  it('uses the default sort when _sort is absent', () => {
    expect(ok({}).sort).toEqual([{ field: 'createdAt', order: 'desc' }]);
    expect(ok({ _order: 'asc' }).sort).toEqual([{ field: 'createdAt', order: 'desc' }]);
  });

  it('pairs fields with directions in order', () => {
    expect(ok({ _sort: 'name,createdAt', _order: 'desc,asc' }).sort).toEqual([
      { field: 'name', order: 'desc' },
      { field: 'createdAt', order: 'asc' },
    ]);
  });

  it('defaults missing directions to asc and ignores case', () => {
    expect(ok({ _sort: 'name,id', _order: 'DESC' }).sort).toEqual([
      { field: 'name', order: 'desc' },
      { field: 'id', order: 'asc' },
    ]);
    expect(ok({ _sort: 'name' }).sort).toEqual([{ field: 'name', order: 'asc' }]);
  });

  it('accepts repeated _sort keys and drops duplicate fields', () => {
    expect(ok({ _sort: ['name', 'id,name'] }).sort.map((s) => s.field)).toEqual(['name', 'id']);
  });

  it('refuses an unknown field and names _sort', () => {
    const issues = fails({ _sort: 'passwordHash' });
    expect(issues).toEqual([expect.objectContaining({ path: '_sort', code: 'invalid_value' })]);
    expect(issues[0]?.message).toContain('Unknown sort field "passwordHash"');
    expect(issues[0]?.message).toContain('name, createdAt, id');
  });

  it('refuses bad directions and too many of them', () => {
    expect(fails({ _sort: 'name', _order: 'sideways' })[0]?.path).toBe('_order');
    expect(fails({ _sort: 'name', _order: 'asc,desc' })[0]?.path).toBe('_order');
  });
});

describe('search', () => {
  it('returns the trimmed text with the configured fields', () => {
    expect(ok({ q: '  rami  ' }).search).toEqual({ text: 'rami', fields: ['name', 'email'] });
    expect(ok({ q: '   ' }).search).toBeUndefined();
    expect(ok({}).search).toBeUndefined();
  });

  it('refuses q on a list without search fields, and a repeated or oversized q', () => {
    const plain = listQuery({ sorts: ['id'], defaultSort: { field: 'id', order: 'asc' } });
    const result = plain.safeParse({ q: 'x' });
    expect(result.success).toBe(false);
    expect(fails({ q: ['a', 'b'] })[0]?.path).toBe('q');
    expect(fails({ q: 'x'.repeat(201) })[0]?.path).toBe('q');
  });
});

describe('filters', () => {
  it('reads exact filters of every type', () => {
    const parsed = ok({ status: 'active', 'role.id': '3', name: 'Rami', twofaEnabled: 'true', balance: '12.5000' });
    expect(parsed.filters).toEqual([
      { field: 'status', op: 'eq', values: ['active'] },
      { field: 'role.id', op: 'eq', values: [3] },
      { field: 'name', op: 'eq', values: ['Rami'] },
      { field: 'twofaEnabled', op: 'eq', values: [true] },
      { field: 'balance', op: 'eq', values: ['12.5000'] },
    ]);
  });

  it('turns a repeated key into IN and a repeated _ne into NOT IN', () => {
    const parsed = ok({ status: ['active', 'invited'], status_ne: ['suspended', 'invited'] });
    expect(parsed.filters).toEqual([
      { field: 'status', op: 'eq', values: ['active', 'invited'] },
      { field: 'status', op: 'ne', values: ['suspended', 'invited'] },
    ]);
  });

  it('reads comparison suffixes', () => {
    const parsed = ok({
      createdAt_gte: '2026-03-01T00:00:00.000Z',
      createdAt_lt: '2026-04-01T00:00:00.000Z',
      age_gte: '18',
      age_lte: '65',
    });
    expect(parsed.filters).toEqual([
      { field: 'createdAt', op: 'gte', values: [new Date('2026-03-01T00:00:00.000Z')] },
      { field: 'createdAt', op: 'lt', values: [new Date('2026-04-01T00:00:00.000Z')] },
      { field: 'age', op: 'gte', values: [18] },
      { field: 'age', op: 'lte', values: [65] },
    ]);
  });

  it('reads _like as a contains filter', () => {
    expect(ok({ name_like: 'ram' }).filters).toEqual([{ field: 'name', op: 'like', values: ['ram'] }]);
  });

  it('accepts a time offset whose plus sign arrived as a space', () => {
    const parsed = ok({ createdAt_gte: '2026-03-01T10:00:00.000 02:00' });
    expect(parsed.filters[0]?.values[0]).toEqual(new Date('2026-03-01T08:00:00.000Z'));
  });

  it('skips empty values', () => {
    expect(ok({ status: '', name: ['', 'x'] }).filters).toEqual([{ field: 'name', op: 'eq', values: ['x'] }]);
  });

  it('refuses an unknown filter and names it', () => {
    expect(fails({ passwordHash: 'x' })).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['passwordHash'] }),
    ]);
    expect(fails({ status_in: 'a' })).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['status_in'] }),
    ]);
  });

  it('refuses an operator the filter does not allow', () => {
    expect(fails({ age: '18' })[0]).toMatchObject({ path: 'age' });
    expect(fails({ status_gte: 'active' })[0]).toMatchObject({ path: 'status_gte' });
    expect(fails({ createdAt_like: 'x' })[0]).toMatchObject({ path: 'createdAt_like' });
  });

  it('refuses repeats on comparison operators and more than 100 values', () => {
    expect(fails({ age_gte: ['1', '2'] })[0]).toMatchObject({ path: 'age_gte' });
    expect(fails({ status: Array.from({ length: 101 }, () => 'active') })[0]).toMatchObject({ path: 'status' });
  });

  it('refuses malformed values and names the key', () => {
    expect(fails({ status: 'deleted' })[0]).toMatchObject({ path: 'status', code: 'invalid_value' });
    expect(fails({ 'role.id': 'abc' })[0]).toMatchObject({ path: 'role.id' });
    expect(fails({ 'role.id': '0' })[0]).toMatchObject({ path: 'role.id' });
    expect(fails({ twofaEnabled: 'yes' })[0]).toMatchObject({ path: 'twofaEnabled' });
    expect(fails({ createdAt_gte: 'yesterday' })[0]).toMatchObject({ path: 'createdAt_gte' });
    expect(fails({ balance: '1e5' })[0]).toMatchObject({ path: 'balance' });
    expect(fails({ name: 'x'.repeat(201) })[0]).toMatchObject({ path: 'name' });
  });

  it('reports every problem, not only the first', () => {
    const issues = fails({ _start: 'x', _sort: 'nope', foo: '1', status: 'bad' });
    expect(issues.map((i) => i.path || i.keys?.join(',')).sort()).toEqual(['_sort', '_start', 'foo', 'status']);
  });
});

describe('extra parameters', () => {
  it('parses them with their own schemas', () => {
    expect(ok({ open: 'true', from: '2026-03-01' }).extra).toEqual({ open: true, from: '2026-03-01' });
    expect(ok({}).extra).toEqual({});
  });

  it('reports a bad extra value under its name', () => {
    expect(fails({ from: '2026-02-30' })[0]).toMatchObject({ path: 'from' });
    expect(fails({ open: 'maybe' })[0]).toMatchObject({ path: 'open' });
  });

  it('accepts a query object without a prototype, as Fastify builds it', () => {
    const query = Object.assign(Object.create(null) as Record<string, string>, { status: 'active' });
    expect(ok(query).filters).toEqual([{ field: 'status', op: 'eq', values: ['active'] }]);
  });
});

describe('configuration checks', () => {
  it('rejects inconsistent definitions at build time', () => {
    const base = { sorts: ['id'] as const, defaultSort: { field: 'id', order: 'asc' } as const };
    expect(() => listQuery({ ...base, defaultSort: { field: 'nope' as 'id', order: 'asc' } })).toThrow(/default sort/);
    expect(() => listQuery({ sorts: [] as unknown as readonly ['id'], defaultSort: base.defaultSort })).toThrow(
      /at least one/,
    );
    expect(() => listQuery({ ...base, filters: { q: { type: 'string' } } })).toThrow(/reserved/);
    expect(() => listQuery({ ...base, filters: { a: { type: 'enum' } } })).toThrow(/needs values/);
    expect(() => listQuery({ ...base, filters: { a: { type: 'boolean', ops: ['gte'] } } })).toThrow(/does not apply/);
    expect(() => listQuery({ ...base, filters: { a: { type: 'string' } }, extra: { a: z.string() } })).toThrow(
      /collides/,
    );
    expect(() => listQuery({ ...base, maxPage: 0 })).toThrow(/maxPage/);
  });

  it('is recognisable as a list query and describes itself', () => {
    expect(isListQuerySchema(staff)).toBe(true);
    expect(isListQuerySchema(z.object({}))).toBe(false);
    expect(describeListQuery(staff).sorts).toEqual(['name', 'createdAt', 'id']);
    const names = listQueryParameters(staff).map((p) => p.name);
    for (const expected of [
      '_start',
      '_end',
      '_sort',
      '_order',
      'q',
      'status',
      'status_ne',
      'createdAt_gte',
      'name_like',
      'age_gte',
      'open',
      'from',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('age');
    expect(listQueryParameters(staff).find((p) => p.name === 'status')?.repeatable).toBe(true);
    expect(listQueryParameters(staff).find((p) => p.name === 'createdAt_gte')?.repeatable).toBe(false);
  });
});
