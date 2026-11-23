// Unit tests of the import rules: classification of a picked item, the type check, the mapping of custom fields and what a supplier
// service becomes in the catalog (decision 042: the supplier's own main box).
import { describe, expect, it } from 'bun:test';
import {
  MAX_NAMED_MISFITS,
  categoryMismatchMessage,
  categoryMisfits,
  classifyImportItem,
  fieldsToRequire,
  importShape,
  importableType,
  importedFields,
  isSupplierFlagOn,
  mainInputField,
  quantityDiffers,
} from '@src/modules/suppliers/domain/import-plan';

describe('classifyImportItem', () => {
  const item = { credit: '19.8000' };

  it('is new when no service links the item', () => {
    expect(classifyImportItem(item, '1.00000000', null)).toMatchObject({ state: 'new', previousCost: null });
    expect(classifyImportItem(item, '1.00000000', null).cost.toWire()).toBe('19.8000');
  });

  it('is matching when the linked service costs the same, changed (with the previous cost) when it differs', () => {
    const linked = {
      serviceId: 17,
      name: 'SRV Chimera',
      cost: '19.8000',
      archived: false,
      minQty: 1,
      maxQty: 1,
      qtyOptions: [],
    };
    expect(classifyImportItem(item, '1.00000000', linked).state).toBe('matching');
    const changed = classifyImportItem(item, '1.00000000', { ...linked, cost: '17.0000' });
    expect(changed.state).toBe('changed');
    expect(changed.previousCost?.toWire()).toBe('17.0000');
  });

  it('applies the credit rate', () => {
    expect(classifyImportItem(item, '0.50000000', null).cost.toWire()).toBe('9.9000');
  });
});

describe('quantityDiffers', () => {
  const linked = { serviceId: 17, name: 'SRV', cost: '1.0000', archived: false, minQty: 1, maxQty: 50, qtyOptions: [] };
  it('is false for a new item and for an archived link', () => {
    expect(quantityDiffers(null, { minQty: 5, maxQty: 5, qtyOptions: [] })).toBe(false);
    expect(quantityDiffers({ ...linked, archived: true }, { minQty: 5, maxQty: 5, qtyOptions: [] })).toBe(false);
  });
  it('is false when the three values are equal and true when any differs', () => {
    expect(quantityDiffers(linked, { minQty: 1, maxQty: 50, qtyOptions: [] })).toBe(false);
    expect(quantityDiffers(linked, { minQty: 2, maxQty: 50, qtyOptions: [] })).toBe(true);
    expect(quantityDiffers(linked, { minQty: 1, maxQty: 60, qtyOptions: [] })).toBe(true);
    expect(quantityDiffers(linked, { minQty: 1, maxQty: 50, qtyOptions: [1, 50] })).toBe(true);
    const packs = { ...linked, qtyOptions: [1, 10, 50] };
    expect(quantityDiffers(packs, { minQty: 1, maxQty: 50, qtyOptions: [1, 10, 50] })).toBe(false);
    expect(quantityDiffers(packs, { minQty: 1, maxQty: 50, qtyOptions: [1, 20, 50] })).toBe(true);
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
        regex: '',
      },
      {
        key: 'model',
        label: 'Model',
        fieldType: 'select',
        options: ['A1', 'B2', 'C3'],
        required: false,
        supplierKey: 'Model',
        sort: 1,
        regex: '',
      },
      {
        key: 'account_user_2',
        label: 'account user',
        fieldType: 'textarea',
        options: [],
        required: false,
        supplierKey: 'account user',
        sort: 2,
        regex: '',
      },
    ]);
  });
});

// Sample entries shaped like a classic Dhru service list; the names, ids and numbers are made up for these tests.
const ecidEntry = {
  SERVICEID: '9101',
  SERVICENAME: 'Sample ECID lookup',
  CREDIT: '3.0000',
  CUSTOM: {
    allow: '1',
    bulk: '0',
    customname: 'ECID',
    custominfo: 'Hex ECID',
    customlen: '13',
    maxlength: '16',
    regex: '',
    isalpha: '1',
  },
};

describe('importShape', () => {
  it('makes an IMEI service whose main box is an ECID a server service with that box first, regex from the lengths', () => {
    expect(importShape({ type: 'IMEI', customFields: [], raw: ecidEntry })).toEqual({
      type: 'server',
      fields: [
        {
          key: 'ecid',
          label: 'ECID',
          fieldType: 'text',
          options: [],
          required: true,
          supplierKey: 'IMEI',
          sort: 0,
          regex: '^.{13,16}$',
        },
      ],
    });
  });

  it('puts the Requires.Custom fields after the main box, from sort 1, with a unique key', () => {
    const raw = { CUSTOM: { allow: 1, customname: 'Serial Number', maxlength: 12 } };
    const shape = importShape({
      type: 'imei',
      customFields: [
        { fieldname: 'Serial Number', fieldtype: 'text', required: '1' },
        { fieldname: 'Model', fieldtype: 'dropdown', fieldoptions: 'A, B' },
      ],
      raw,
    });
    expect(shape.type).toBe('server');
    expect(shape.fields.map((field) => [field.key, field.supplierKey, field.sort, field.regex])).toEqual([
      ['serial_number_2', 'IMEI', 0, '^.{1,12}$'],
      ['serial_number', 'Serial Number', 1, ''],
      ['model', 'Model', 2, ''],
    ]);
  });

  it('keeps a box named only IMEI (any spelling) as an imei service', () => {
    for (const customname of ['IMEI', 'imei no', 'IMEI Number', ' I.M.E.I ']) {
      const raw = { CUSTOM: { allow: '1', customname, maxlength: '15' } };
      expect(importShape({ type: 'IMEI', customFields: [], raw }), customname).toEqual({ type: 'imei', fields: [] });
    }
  });

  it('keeps an imei service when the box is not allowed, missing or unnamed', () => {
    for (const custom of [
      { allow: '0', customname: 'ECID' },
      { allow: '1', customname: '  ' },
      'ECID',
      null,
      ['ECID'],
    ]) {
      expect(importShape({ type: 'IMEI', customFields: [], raw: { CUSTOM: custom } }).type).toBe('imei');
    }
    expect(importShape({ type: 'IMEI', customFields: [], raw: {} }).type).toBe('imei');
  });

  it('never changes a server, remote or file service, nor makes an unknown type importable', () => {
    const raw = { CUSTOM: { allow: '1', customname: 'Username' } };
    const fields = [{ fieldname: 'Username', fieldtype: 'text', required: '1' }];
    for (const type of ['SERVER', 'Remote', 'file']) {
      const shape = importShape({ type, customFields: fields, raw });
      expect(shape.type).toBe(type.toLowerCase() as 'server');
      expect(shape.fields.map((field) => field.supplierKey)).toEqual(['Username']);
    }
    expect(importShape({ type: 'Credits', customFields: [], raw }).type).toBeUndefined();
  });

  it("takes the 'SN OR IMEI' box as a main input with the length pattern, never the supplier's own regex", () => {
    const raw = {
      CUSTOM: {
        allow: true,
        customname: 'SN  OR\tIMEI',
        customlen: '8',
        maxlength: '15',
        regex: '/^[A-Z0-9]{8,15}$/i',
      },
    };
    const [main] = importShape({ type: 'IMEI', customFields: [], raw }).fields;
    expect(main).toMatchObject({
      key: 'sn_or_imei',
      label: 'SN OR IMEI',
      supplierKey: 'IMEI',
      regex: '^.{8,15}$',
    });
    for (const regex of ['^(\\w+\\s?)+$', '\\A\\d+\\z', '/^[0-9]+$/']) {
      const shaped = importShape({
        type: 'IMEI',
        customFields: [],
        raw: { CUSTOM: { allow: '1', customname: 'SN', regex } },
      });
      expect(shaped.fields[0]!.regex, regex).toBe('');
    }
  });
});

describe('mainInputField', () => {
  it('has no pattern without a maximum, and a key that avoids the keys already used', () => {
    const field = mainInputField({ label: 'Lock Code', minLength: 4, maxLength: null }, new Set(['lock_code']));
    expect(field).toEqual({
      key: 'lock_code_2',
      label: 'Lock Code',
      fieldType: 'text',
      options: [],
      required: true,
      supplierKey: 'IMEI',
      sort: 0,
      regex: '',
    });
  });
});

describe('isSupplierFlagOn', () => {
  it('is on for true, 1 and the texts on, 1, yes, true, required, y (trimmed, any case)', () => {
    for (const value of [true, 1, 'on', ' ON ', '1', 'yes', 'True', 'required', 'Y']) {
      expect(isSupplierFlagOn(value), String(value)).toBe(true);
    }
    for (const value of ['', 'off', '0', 'no', 0, false, null, undefined, 2, 'checked', {}]) {
      expect(isSupplierFlagOn(value), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });
});

describe('importedFields reads a Dhru Fusion field description', () => {
  // Shaped like a real Dhru Fusion entry; names and options are made up.
  const fusion = (over: Record<string, unknown>) => ({
    type: 'serviceimei',
    fieldname: 'Sample Field',
    fieldtype: 'text',
    description: '',
    fieldoptions: '',
    required: '',
    regexpr: '',
    adminonly: '',
    ...over,
  });

  it('makes "on" required and "" optional, reads radio as a select, leaves adminonly out and never uses regexpr', () => {
    const fields = importedFields([
      fusion({ fieldname: 'Account Email', required: 'on', regexpr: '^(\\w+\\s?)+$' }),
      fusion({ fieldname: 'Note' }),
      fusion({ fieldname: 'Plan', fieldtype: 'radio', fieldoptions: 'Basic, Pro', required: 'on' }),
      fusion({ fieldname: 'Staff Ref', required: 'on', adminonly: 'on' }),
    ]);
    expect(
      fields.map((field) => [field.key, field.required, field.fieldType, field.options, field.regex, field.sort]),
    ).toEqual([
      ['account_email', true, 'text', [], '', 0],
      ['note', false, 'text', [], '', 1],
      ['plan', true, 'select', ['Basic', 'Pro'], '', 2],
    ]);
  });
});

describe('fieldsToRequire', () => {
  const supplier = [
    { fieldname: 'Account Email', required: 'on' },
    { fieldname: 'Region', required: 'on' },
    { fieldname: 'Note', required: '' },
    { fieldname: 'Staff Ref', required: 'on', adminonly: 'on' },
  ];

  it('lists the optional fields whose supplier name matches a required supplier field, exactly or without case and spaces', () => {
    const fields = [
      { key: 'account_email', supplierKey: 'Account Email', required: false },
      { key: 'region', supplierKey: ' region ', required: false },
      { key: 'note', supplierKey: 'Note', required: false },
      { key: 'staff_ref', supplierKey: 'Staff Ref', required: false },
    ];
    expect(fieldsToRequire(fields, {}, supplier)).toEqual(['account_email', 'region']);
  });

  it("reads the link's field map first, then the key when the supplier key is empty, and never lists a required field", () => {
    const fields = [
      { key: 'mail', supplierKey: 'Other', required: false },
      { key: 'Region', supplierKey: '', required: false },
      { key: 'account', supplierKey: 'Account Email', required: true },
    ];
    expect(fieldsToRequire(fields, { mail: 'Account Email' }, supplier)).toEqual(['mail', 'Region']);
    expect(fieldsToRequire(fields, {}, [])).toEqual([]);
  });
});

describe('categoryMisfits', () => {
  const items = [
    { name: 'Telstra Australia', type: 'imei' as const },
    { name: 'Server pack', type: 'server' as const },
    { name: 'Rogers Canada', type: 'imei' as const },
    { name: 'Unlock file', type: 'file' as const },
  ];

  it('keeps the services whose type is not the category type, in the order given', () => {
    expect(categoryMisfits(items, { type: 'imei' }).map((item) => item.name)).toEqual(['Server pack', 'Unlock file']);
    expect(categoryMisfits(items, { type: 'server' }).map((item) => item.name)).toEqual([
      'Telstra Australia',
      'Rogers Canada',
      'Unlock file',
    ]);
  });

  it('finds nothing when every service has the type, and for no service at all', () => {
    expect(categoryMisfits([items[0]!, items[2]!], { type: 'imei' })).toEqual([]);
    expect(categoryMisfits([], { type: 'remote' })).toEqual([]);
  });
});

describe('categoryMismatchMessage', () => {
  const category = { name: 'Carrier unlock', type: 'imei' };

  it('names the category, its type and every service that does not fit, with the type it would be', () => {
    const message = categoryMismatchMessage(category, [
      { name: 'Server pack', type: 'server' },
      { name: 'Unlock file', type: 'file' },
    ]);
    expect(message).toContain('"Carrier unlock"');
    expect(message).toContain('imei services only');
    expect(message).toContain('"Server pack" (server), "Unlock file" (file)');
    expect(message).not.toContain('more');
  });

  it('names at most ten services and counts the rest', () => {
    const many = Array.from({ length: MAX_NAMED_MISFITS + 3 }, (_, index) => ({
      name: `Service ${index + 1}`,
      type: 'server' as const,
    }));
    const message = categoryMismatchMessage(category, many);
    expect(message).toContain(`"Service ${MAX_NAMED_MISFITS}" (server) and 3 more`);
    expect(message).not.toContain(`"Service ${MAX_NAMED_MISFITS + 1}"`);
  });
});
