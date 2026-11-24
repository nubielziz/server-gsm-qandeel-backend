// Unit tests of the custom field answers of an order with their labels (decision 065).
import { describe, expect, it } from 'bun:test';
import { orderAnswers } from '@src/modules/orders/domain/order-answers';

const fields = [
  { id: 3, key: 'serial', label: 'Serial number', sort: 2 },
  { id: 1, key: 'username', label: 'Username', sort: 1 },
  { id: 2, key: 'account', label: 'Account', sort: 2 },
];

describe('orderAnswers', () => {
  it('lists the fields that have a value in form order (sort, then id) with their labels', () => {
    const inputs = { serial: 'S1', username: 'amir92', account: 'acc-1' };
    expect(orderAnswers(inputs, fields)).toEqual([
      { key: 'username', label: 'Username', value: 'amir92' },
      { key: 'account', label: 'Account', value: 'acc-1' },
      { key: 'serial', label: 'Serial number', value: 'S1' },
    ]);
  });

  it('leaves out a field without a value, an empty value and a null', () => {
    expect(orderAnswers({ username: '  ', account: null, serial: 'S1' }, fields)).toEqual([
      { key: 'serial', label: 'Serial number', value: 'S1' },
    ]);
    expect(orderAnswers({}, fields)).toEqual([]);
  });

  it('keeps a stored key that no field has any more, after the fields, under its own key as the label', () => {
    const inputs = { old_field: 'kept', username: 'amir92', also_gone: 'too' };
    expect(orderAnswers(inputs, fields)).toEqual([
      { key: 'username', label: 'Username', value: 'amir92' },
      { key: 'old_field', label: 'old_field', value: 'kept' },
      { key: 'also_gone', label: 'also_gone', value: 'too' },
    ]);
    expect(orderAnswers({ old_field: 'kept' }, [])).toEqual([{ key: 'old_field', label: 'old_field', value: 'kept' }]);
  });

  it('writes a value that is not text as text', () => {
    const inputs = { username: 12, account: true, serial: { a: 1 } };
    expect(orderAnswers(inputs, fields).map((answer) => answer.value)).toEqual(['12', 'true', '{"a":1}']);
  });

  it('does not read a key from the prototype', () => {
    expect(orderAnswers({}, [{ id: 1, key: 'constructor', label: 'Constructor', sort: 1 }])).toEqual([]);
  });
});
