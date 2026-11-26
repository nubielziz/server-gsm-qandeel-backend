// Unit tests of the import rules: classification of a picked item, the type check, the mapping of custom fields and what a supplier
// service becomes in the catalog (decision 042: the supplier's own main box; decision 071: the IMEI field of a plain IMEI service and the
// box an adoption makes).
import { describe, expect, it } from 'bun:test';
import {
  IMEI_FIELD_NAME,
  MAX_NAMED_MISFITS,
  adoptedBox,
  categoryMismatchMessage,
  categoryMisfits,
  classifyImportItem,
  fieldsToRequire,
  imeiInputField,
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

// Arabic text that a supplier types is data and must keep working; the guard of decision 039 wants it written as escapes.
const DEVICE_NUMBER = '\u0631\u0642\u0645 \u0627\u0644\u062c\u0647\u0627\u0632';
const USER_NAME = '\u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645';
const SERIAL_NAME = '\u0631\u0642\u0645 \u062a\u0633\u0644\u0633\u0644\u064a';

describe('importedFields', () => {
  it('maps the supplier fields to ours: Name as spelled, key in snake case, type, options, required, never the main input', () => {
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
        isMainInput: false,
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
        isMainInput: false,
        sort: 1,
        regex: '',
      },
      {
        key: 'account_user_2',
        label: 'account user 2',
        fieldType: 'textarea',
        options: [],
        required: false,
        supplierKey: 'account user 2',
        isMainInput: false,
        sort: 2,
        regex: '',
      },
    ]);
  });

  it("keeps the supplier's spelling of a Name, trimmed, and uses the description as the label only when there is one", () => {
    const fields = importedFields([
      { fieldname: '  Serial No.  ', description: 'The serial number' },
      { fieldname: 'E-Mail (work)' },
    ]);
    expect(fields.map((field) => [field.supplierKey, field.key, field.label])).toEqual([
      ['Serial No.', 'serial_no', 'The serial number'],
      ['E-Mail (work)', 'e_mail_work', 'E-Mail (work)'],
    ]);
  });

  it('gives a later name that differs only in letter case the first free number, for the Name and the key', () => {
    const fields = importedFields([
      { fieldname: 'Email' },
      { fieldname: 'email' },
      { fieldname: 'EMAIL' },
      { fieldname: 'Email 2' },
      { fieldname: ' EMAIL ' },
    ]);
    expect(fields.map((field) => [field.supplierKey, field.key])).toEqual([
      ['Email', 'email'],
      ['email 2', 'email_2'],
      ['EMAIL 3', 'email_3'],
      ['Email 2 2', 'email_2_2'],
      ['EMAIL 4', 'email_4'],
    ]);
    const names = fields.map((field) => field.supplierKey.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps a name in a script without Latin letters whole as the Name and makes the key field, field_2', () => {
    const fields = importedFields([{ fieldname: DEVICE_NUMBER }, { fieldname: USER_NAME }]);
    expect(fields.map((field) => [field.supplierKey, field.key])).toEqual([
      [DEVICE_NUMBER, 'field'],
      [USER_NAME, 'field_2'],
    ]);
  });

  it('cuts only a numbered Name, so that it stays within 120 characters, and a key within 60', () => {
    const long = 'A'.repeat(130);
    const [first, second] = importedFields([{ fieldname: long }, { fieldname: long.toLowerCase() }]);
    expect(first!.supplierKey).toBe(long);
    expect(first!.key).toBe('a'.repeat(60));
    expect(second!.supplierKey).toHaveLength(120);
    expect(second!.supplierKey.endsWith(' 2')).toBe(true);
    expect(second!.key).toHaveLength(60);
    expect(second!.key.endsWith('_2')).toBe(true);
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
          supplierKey: 'ECID',
          isMainInput: true,
          sort: 0,
          regex: '^.{13,16}$',
        },
      ],
    });
  });

  it('puts the Requires.Custom fields after the main box, from sort 1, with a unique key and a unique Name', () => {
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
    expect(
      shape.fields.map((field) => [field.key, field.supplierKey, field.isMainInput, field.sort, field.regex]),
    ).toEqual([
      ['serial_number_2', 'Serial Number 2', true, 0, '^.{1,12}$'],
      ['serial_number', 'Serial Number', false, 1, ''],
      ['model', 'Model', false, 2, ''],
    ]);
  });

  it("gives the box the number when its name is a custom field's name in another letter case: the supplier's field keeps its name", () => {
    const shape = importShape({
      type: 'imei',
      customFields: [{ fieldname: 'serial number', fieldtype: 'text' }],
      raw: { CUSTOM: { allow: 1, customname: 'Serial Number', maxlength: 12 } },
    });
    expect(shape.fields.map((field) => [field.key, field.supplierKey, field.isMainInput])).toEqual([
      ['serial_number_2', 'Serial Number 2', true],
      ['serial_number', 'serial number', false],
    ]);
  });

  it('flags only the box when there is one: at most one main input in the shape, and none for a server service', () => {
    const raw = { CUSTOM: { allow: '1', customname: 'ECID', maxlength: '16' } };
    const customFields = [{ fieldname: 'IMEI' }, { fieldname: 'Model' }];
    const withBox = importShape({ type: 'IMEI', customFields, raw });
    expect(withBox.fields.filter((field) => field.isMainInput).map((field) => field.key)).toEqual(['ecid']);
    // Beside a box, a supplier field that the supplier itself names IMEI is an ordinary field with that Name.
    expect(withBox.fields.map((field) => field.supplierKey)).toEqual(['ECID', 'IMEI', 'Model']);
    const server = importShape({ type: 'Server', customFields, raw: {} });
    expect(server.fields.some((field) => field.isMainInput)).toBe(false);
  });

  it('makes the first field named IMEI in any letter case the main input of a service that stays imei, so no second IMEI box is drawn', () => {
    for (const name of ['IMEI', 'imei', ' Imei ']) {
      const shape = importShape({
        type: 'IMEI',
        customFields: [{ fieldname: 'Model' }, { fieldname: name }, { fieldname: 'IMEI Number' }],
        raw: {},
      });
      expect(shape.type, name).toBe('imei');
      expect(
        shape.fields.map((field) => [field.key, field.supplierKey, field.isMainInput]),
        name,
      ).toEqual([
        ['model', 'Model', false],
        ['imei', name.trim(), true],
        ['imei_number', 'IMEI Number', false],
      ]);
    }
    // A box named only IMEI keeps the service imei, and its field named IMEI is the main input too.
    const boxed = importShape({
      type: 'IMEI',
      customFields: [{ fieldname: 'IMEI' }, { fieldname: 'imei' }],
      raw: { CUSTOM: { allow: '1', customname: 'IMEI', maxlength: '15' } },
    });
    expect(boxed.type).toBe('imei');
    expect(boxed.fields.map((field) => [field.supplierKey, field.isMainInput])).toEqual([
      ['IMEI', true],
      ['imei 2', false],
    ]);
    // No field named IMEI: none of the supplier's fields is flagged; the service gets its own IMEI field first (decision 071).
    const none = importShape({ type: 'IMEI', customFields: [{ fieldname: 'IMEI No' }], raw: {} });
    expect(none.fields.map((field) => [field.key, field.supplierKey, field.isMainInput, field.sort])).toEqual([
      ['imei', 'IMEI', true, 0],
      ['imei_no', 'IMEI No', false, 1],
    ]);
  });

  it('makes the flagged supplier field named IMEI of type imei when the supplier says text, and keeps any other type (decision 073)', () => {
    const typed = (fieldtype: string) =>
      importShape({
        type: 'IMEI',
        customFields: [
          { fieldname: 'imei', fieldtype, fieldoptions: 'A,B' },
          { fieldname: 'Note', fieldtype: 'text' },
        ],
        raw: {},
      }).fields.map((field) => [field.supplierKey, field.fieldType, field.isMainInput]);
    for (const fieldtype of ['text', '', 'anything']) {
      expect(typed(fieldtype), fieldtype).toEqual([
        ['imei', 'imei', true],
        ['Note', 'text', false],
      ]);
    }
    expect(typed('dropdown')[0]).toEqual(['imei', 'select', true]);
    expect(typed('textarea')[0]).toEqual(['imei', 'textarea', true]);
    expect(typed('number')[0]).toEqual(['imei', 'number', true]);
    // A server service keeps a supplier field named IMEI as an ordinary text field.
    const server = importShape({ type: 'Server', customFields: [{ fieldname: 'IMEI', fieldtype: 'text' }], raw: {} });
    expect(server.fields.map((field) => [field.fieldType, field.isMainInput])).toEqual([['text', false]]);
  });

  it('gives a service that stays imei with no field named IMEI the IMEI field first, of type imei, the supplier fields after it (decisions 071 and 073)', () => {
    const shape = importShape({
      type: 'IMEI',
      customFields: [
        { fieldname: 'Model', fieldtype: 'dropdown', fieldoptions: 'A, B', required: 'on' },
        { fieldname: 'Note', fieldtype: 'text' },
      ],
      raw: {},
    });
    expect(shape.type).toBe('imei');
    expect(shape.fields).toEqual([
      {
        key: 'imei',
        label: 'IMEI',
        fieldType: 'imei',
        options: [],
        required: true,
        supplierKey: 'IMEI',
        isMainInput: true,
        sort: 0,
        regex: '',
      },
      {
        key: 'model',
        label: 'Model',
        fieldType: 'select',
        options: ['A', 'B'],
        required: true,
        supplierKey: 'Model',
        isMainInput: false,
        sort: 1,
        regex: '',
      },
      {
        key: 'note',
        label: 'Note',
        fieldType: 'text',
        options: [],
        required: false,
        supplierKey: 'Note',
        isMainInput: false,
        sort: 2,
        regex: '',
      },
    ]);
    // Exactly one main input in the shape.
    expect(shape.fields.filter((field) => field.isMainInput)).toHaveLength(1);
  });

  it("takes the next free key when a supplier's field already holds imei, and keeps the supplier's field as it was", () => {
    const shape = importShape({
      type: 'IMEI',
      customFields: [{ fieldname: 'IMEI:' }, { fieldname: 'IMEI-2' }],
      raw: {},
    });
    expect(shape.fields.map((field) => [field.key, field.supplierKey, field.isMainInput, field.sort])).toEqual([
      ['imei_3', 'IMEI', true, 0],
      ['imei', 'IMEI:', false, 1],
      ['imei_2', 'IMEI-2', false, 2],
    ]);
  });

  it('keeps a box named only IMEI (any spelling) as an imei service, with the IMEI field as its only field', () => {
    for (const customname of ['IMEI', 'imei no', 'IMEI Number', ' I.M.E.I ']) {
      const raw = { CUSTOM: { allow: '1', customname, maxlength: '15' } };
      expect(importShape({ type: 'IMEI', customFields: [], raw }), customname).toEqual({
        type: 'imei',
        fields: [imeiInputField(new Set())],
      });
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
      // No IMEI field on another type, not even without fields (decision 071 is about IMEI services only).
      expect(importShape({ type, customFields: [], raw: {} }).fields).toEqual([]);
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
      supplierKey: 'SN OR IMEI',
      isMainInput: true,
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
  const none = { keys: new Set<string>(), names: new Set<string>() };

  it('has no pattern without a maximum, its Name is its label and its key avoids the keys already used', () => {
    const field = mainInputField(
      { label: 'Lock Code', minLength: 4, maxLength: null },
      { keys: new Set(['lock_code']), names: new Set() },
    );
    expect(field).toEqual({
      key: 'lock_code_2',
      label: 'Lock Code',
      fieldType: 'text',
      options: [],
      required: true,
      supplierKey: 'Lock Code',
      isMainInput: true,
      sort: 0,
      regex: '',
    });
  });

  it('takes the number for its Name when another field has that Name in any letter case', () => {
    const used = { keys: new Set(['lock_code']), names: new Set(['lock code', 'lock code 2']) };
    const field = mainInputField({ label: 'Lock Code', minLength: 1, maxLength: 8 }, used);
    expect(field).toMatchObject({
      key: 'lock_code_2',
      supplierKey: 'Lock Code 3',
      isMainInput: true,
      regex: '^.{1,8}$',
    });
  });

  it('is never named IMEI because of the box: a label that says IMEI is kept as the Name', () => {
    expect(mainInputField({ label: 'IMEI', minLength: 1, maxLength: null }, none)).toMatchObject({
      key: 'imei',
      supplierKey: 'IMEI',
      isMainInput: true,
    });
  });

  it('keeps a label in a script without Latin letters as the Name and makes the key field', () => {
    expect(mainInputField({ label: SERIAL_NAME, minLength: 1, maxLength: null }, none)).toMatchObject({
      key: 'field',
      supplierKey: SERIAL_NAME,
    });
    expect(
      mainInputField({ label: SERIAL_NAME, minLength: 1, maxLength: null }, { ...none, keys: new Set(['field']) }),
    ).toMatchObject({ key: 'field_2' });
  });
});

describe('imeiInputField', () => {
  it('is a required field of type imei (decision 073) named and labelled IMEI, flagged, first, without a pattern; its key is imei, else the first free number', () => {
    expect(imeiInputField(new Set())).toEqual({
      key: 'imei',
      label: IMEI_FIELD_NAME,
      fieldType: 'imei',
      options: [],
      required: true,
      supplierKey: IMEI_FIELD_NAME,
      isMainInput: true,
      sort: 0,
      regex: '',
    });
    expect(imeiInputField(new Set(['imei'])).key).toBe('imei_2');
    expect(imeiInputField(new Set(['imei', 'imei_2'])).key).toBe('imei_3');
  });
});

describe('adoptedBox', () => {
  const ecid = { label: 'ECID', minLength: 13, maxLength: 16 };
  const field = (key: string, supplierKey: string, isMainInput = false) => ({ key, supplierKey, isMainInput });

  it('inserts the box as mainInputField makes it when the service has no main-input field', () => {
    const fields = [field('model', 'Model'), field('ecid', 'Other')];
    expect(adoptedBox(ecid, fields)).toEqual({
      field: mainInputField(ecid, { keys: new Set(['model', 'ecid']), names: new Set(['model', 'other']) }),
      replaces: null,
    });
    expect(adoptedBox(ecid, fields).field).toMatchObject({ key: 'ecid_2', supplierKey: 'ECID', isMainInput: true });
  });

  it("turns the main-input field into the box: its key stays, the box's Name, label, pattern and required come in", () => {
    const box = adoptedBox(ecid, [field('imei', 'IMEI', true), field('model', 'Model')]);
    expect(box).toEqual({
      field: {
        key: 'imei',
        label: 'ECID',
        fieldType: 'text',
        options: [],
        required: true,
        supplierKey: 'ECID',
        isMainInput: true,
        sort: 0,
        regex: '^.{13,16}$',
      },
      replaces: 'imei',
    });
  });

  it("checks the box's Name against the other fields only: a clash takes the number, the replaced field's own Name does not count", () => {
    expect(adoptedBox(ecid, [field('model', 'ecid'), field('device', 'Device', true)]).field).toMatchObject({
      key: 'device',
      supplierKey: 'ECID 2',
    });
    // The flagged field may already carry the box's Name: it is the field being renamed, so the Name stays free.
    expect(adoptedBox(ecid, [field('serial', 'ECID', true)]).field).toMatchObject({
      key: 'serial',
      supplierKey: 'ECID',
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

  const field = (key: string, supplierKey: string, over: { required?: boolean; isMainInput?: boolean } = {}) => ({
    key,
    supplierKey,
    required: false,
    isMainInput: false,
    ...over,
  });

  it('lists the optional fields whose Name matches a required supplier field, exactly or without case and spaces', () => {
    const fields = [
      field('account_email', 'Account Email'),
      field('region', ' region '),
      field('note', 'Note'),
      field('staff_ref', 'Staff Ref'),
    ];
    expect(fieldsToRequire(fields, {}, supplier)).toEqual(['account_email', 'region']);
  });

  it("reads the link's field map first, then the Name, and never lists a required field", () => {
    const fields = [
      field('mail', 'Other'),
      field('area', 'Region'),
      field('account', 'Account Email', { required: true }),
    ];
    // The map sends 'mail' as Account Email; 'area' has no map entry, so its Name Region matches.
    expect(fieldsToRequire(fields, { mail: 'Account Email' }, supplier)).toEqual(['mail', 'area']);
    // A map entry that renames a field away from the supplier's name takes it out.
    expect(fieldsToRequire(fields, { area: 'Area Code' }, supplier)).toEqual([]);
    expect(fieldsToRequire(fields, {}, [])).toEqual([]);
  });

  it('never lists the main-input field, even when its Name is a field the supplier requires', () => {
    const fields = [field('device', 'Account Email', { isMainInput: true }), field('region', 'Region')];
    expect(fieldsToRequire(fields, {}, supplier)).toEqual(['region']);
    // Decision 071: the IMEI field of a plain IMEI service is the main input, also when the supplier requires a field named IMEI.
    const imei = [field('imei', 'IMEI', { isMainInput: true }), field('region', 'Region')];
    expect(fieldsToRequire(imei, {}, [...supplier, { fieldname: 'IMEI', required: 'on' }])).toEqual(['region']);
  });

  it('lists a field the supplier itself names IMEI when it is not the main input and the supplier requires it', () => {
    const fields = [field('lock_code', 'Lock Code', { isMainInput: true }), field('imei', 'IMEI')];
    expect(fieldsToRequire(fields, {}, [{ fieldname: 'IMEI', required: 'on' }])).toEqual(['imei']);
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
