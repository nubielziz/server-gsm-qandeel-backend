// Unit tests of the `ids` parameter of GET /client/services (decision 066): what the query schema accepts, what it refuses and how the
// parameter is documented. Without `ids` the parsed request is what it was.
import { describe, expect, it } from 'bun:test';
import { listQueryParameters } from '@src/common/contract/list-query';
import { listClientServices } from '@src/modules/catalog/contracts/merchant-catalog.contracts';

const parse = (query: Record<string, string | string[]>) => listClientServices.query.safeParse(query);
const ids = (value: string | string[]) => {
  const result = parse({ ids: value });
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data.extra.ids;
};
const refused = (value: string | string[]) => {
  const result = parse({ ids: value });
  expect(result.success, JSON.stringify(value)).toBe(false);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
};

describe('the ids parameter of GET /client/services', () => {
  it('reads a comma-separated list of positive whole numbers', () => {
    expect(ids('5')).toEqual([5]);
    expect(ids('5,9,12')).toEqual([5, 9, 12]);
    expect(ids('9007199254740991')).toEqual([9007199254740991]);
  });

  it('counts a repeated id once, in the order it first appears', () => {
    expect(ids('12,5,12,5,9')).toEqual([12, 5, 9]);
  });

  it('takes 100 ids and refuses 101, naming ids', () => {
    const list = (count: number) => Array.from({ length: count }, (_, index) => index + 1).join(',');
    expect(ids(list(100))).toHaveLength(100);
    expect(refused(list(101))).toEqual([{ path: 'ids', message: 'Send at most 100 ids.' }]);
    // The limit counts what was sent, a repeated id included.
    expect(refused(Array.from({ length: 101 }, () => '7').join(','))).toHaveLength(1);
  });

  it('refuses an empty value, an empty piece, spaces, signs, decimals, a leading zero and a number past the id range', () => {
    for (const value of [
      '',
      ',',
      '5,',
      ',5',
      '5,,9',
      ' 5',
      '5 ',
      '5, 9',
      '0',
      '-5',
      '+5',
      '5.0',
      '1.5',
      '05',
      '1e3',
      'abc',
      '5;9',
      '5|9',
    ]) {
      expect(refused(value), JSON.stringify(value)).toEqual([
        { path: 'ids', message: 'Must be comma-separated service ids: positive whole numbers.' },
      ]);
    }
    expect(refused('9007199254740992')).toHaveLength(1);
    expect(refused('99999999999999999')).toHaveLength(1);
  });

  it('refuses a repeated key: the ids travel as one comma-separated value', () => {
    expect(refused(['5', '9'])).toEqual([
      { path: 'ids', message: 'Send the ids as one comma-separated value, such as ids=5,9,12.' },
    ]);
  });

  it('is absent from the parsed request when it is not sent, and the rest of the request parses as before', () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(result.data?.extra).toEqual({});
    expect(result.data?.range).toEqual({ start: 0, end: 25, limit: 25 });
    expect(result.data?.sort).toEqual([
      { field: 'category', order: 'asc' },
      { field: 'name', order: 'asc' },
    ]);
    const combined = parse({ ids: '5,9', type: 'imei', q: 'att', _end: '100' });
    expect(combined.data?.extra.ids).toEqual([5, 9]);
    expect(combined.data?.filters).toHaveLength(1);
    expect(combined.data?.range.limit).toBe(100);
  });

  it('is documented as one optional text parameter with its limit', () => {
    const parameter = listQueryParameters(listClientServices.query).find((item) => item.name === 'ids');
    expect(parameter).toBeDefined();
    expect(parameter?.repeatable).toBe(false);
    expect(parameter?.schema.type).toBe('string');
    expect(parameter?.description).toContain('at most 100');
    expect(listClientServices.description).toContain('ids');
  });
});
