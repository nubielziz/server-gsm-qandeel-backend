// Unit tests of the replace-all list checks: repeated field keys, repeated option values and the pattern check.
import { describe, expect, it } from 'bun:test';
import { duplicateFieldKeys, duplicateOptionValues, isValidPattern } from './service-parts';

describe('duplicateFieldKeys', () => {
  it('names the later occurrence of a repeated key', () => {
    expect(duplicateFieldKeys(['imei', 'account', 'imei', 'account', 'imei'])).toEqual([
      { field: 'fields.2.key', message: 'The key imei is used twice.' },
      { field: 'fields.3.key', message: 'The key account is used twice.' },
      { field: 'fields.4.key', message: 'The key imei is used twice.' },
    ]);
  });

  it('finds nothing in a list of distinct keys', () => {
    expect(duplicateFieldKeys(['a', 'b', 'A'])).toEqual([]);
  });
});

describe('duplicateOptionValues', () => {
  it('names the later occurrence within one list and allows the same value in another list', () => {
    const problems = duplicateOptionValues([
      { list: 'model', value: 'iphone15' },
      { list: 'network', value: 'iphone15' },
      { list: 'model', value: 'iphone15' },
    ]);
    expect(problems).toEqual([{ field: 'options.2.value', message: 'Duplicate in the model list' }]);
  });
});

describe('isValidPattern', () => {
  it('accepts an empty text and a compiling pattern, refuses a broken one', () => {
    expect(isValidPattern('')).toBe(true);
    expect(isValidPattern('^[0-9]{15}$')).toBe(true);
    expect(isValidPattern('([0-9')).toBe(false);
  });
});
