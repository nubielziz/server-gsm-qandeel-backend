// Unit tests of the import rules: classification of a picked item, the type check and the mapping of custom fields.
import { describe, expect, it } from 'bun:test';
import { classifyImportItem, importableType, importedFields } from './import-plan';

describe('classifyImportItem', () => {
  const item = { credit: '19.8000' };

  it('is new when no service links the item', () => {
    expect(classifyImportItem(item, '1.00000000', null)).toMatchObject({ state: 'new', previousCost: null });
    expect(classifyImportItem(item, '1.00000000', null).cost.toWire()).toBe('19.8000');
  });

  it('is matching when the linked service costs the same, changed (with the previous cost) when it differs', () => {
    const linked = { serviceId: 17, name: 'SRV Chimera', cost: '19.8000', archived: false };
    expect(classifyImportItem(item, '1.00000000', linked).state).toBe('matching');
    const changed = classifyImportItem(item, '1.00000000', { ...linked, cost: '17.0000' });
    expect(changed.state).toBe('changed');
    expect(changed.previousCost?.toWire()).toBe('17.0000');
  });

  it('applies the credit rate', () => {
    expect(classifyImportItem(item, '0.50000000', null).cost.toWire()).toBe('9.9000');
  });
});

describe('importableType', () => {
  it('accepts imei, server, remote and file in any case and refuses the rest', () => {
    expect(importableType('IMEI')).toBe('imei');
    expect(importableType(' Server ')).toBe('server');
    expect(importableType('REMOTE')).toBe('remote');
    expect(importableType('file')).toBe('file');
    expect(importableType('Credits')).toBeUndefined();
  });
});

describe('importedFields', () => {
  it('maps the supplier fields to ours: key in snake case, type, options, required and the supplier key', () => {
    const fields = importedFields([
      { fieldname: 'Account User', fieldtype: 'text', description: 'The account', required: '1' },
      { fieldname: 'Model', fieldtype: 'dropdown', fieldoptions: 'A1, B2\nC3', required: 'no' },
      { fieldname: 'account user', fieldtype: 'textarea' },
      { fieldtype: 'text' },
      'junk',
    ]);
    expect(fields).toEqual([
      {
        key: 'account_user',
        label: 'The account',
        fieldType: 'text',
        options: [],
        required: true,
        supplierKey: 'Account User',
        sort: 0,
      },
      {
        key: 'model',
        label: 'Model',
        fieldType: 'select',
        options: ['A1', 'B2', 'C3'],
        required: false,
        supplierKey: 'Model',
        sort: 1,
      },
      {
        key: 'account_user_2',
        label: 'account user',
        fieldType: 'textarea',
        options: [],
        required: false,
        supplierKey: 'account user',
        sort: 2,
      },
    ]);
  });
});
