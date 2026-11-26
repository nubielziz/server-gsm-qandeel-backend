// Integration tests of the replace-all custom fields of a service (feature 4a): PUT /admin/services/:id/fields; and the 404 of the retired
// PUT /admin/services/:id/options (decision 072), whose stored lists stay readable.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { FIELD_PATTERN_MESSAGES } from '@src/common/field-pattern';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';

let t: TestApp;
let admin: AdminApi;
let serviceId: number;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['catalog:*'], { name: 'Rami K.' });
  const { db } = await testDb();
  serviceId = await insertService(db, await insertCategory(db), { name: 'AT&T Unlock' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

/** A field row of the PUT body: a Name and the plain defaults; pass `key` for a saved field. */
const field = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  fieldType: 'text',
  required: false,
  options: [],
  regex: '',
  ...extra,
});
/** What the route answers for a field with the plain defaults. */
const saved = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  key,
  name,
  label: name,
  fieldType: 'text',
  required: false,
  options: [],
  regex: '',
  isMainInput: false,
  ...extra,
});
const putFields = (fields: unknown[]) => admin.put(`/admin/services/${serviceId}/fields`, { fields });
const storedFields = async () =>
  (await testDb()).db
    .select()
    .from(s.serviceFields)
    .where(eq(s.serviceFields.serviceId, serviceId))
    .orderBy(s.serviceFields.sort);
const errorFields = (res: { body: { errors: Array<{ field: string }> } }) => res.body.errors.map((e) => e.field);

describe('PUT /admin/services/:id/fields', () => {
  it('replaces the list in order, deletes what is left out, answers the saved list and audits it', async () => {
    const first = await putFields([
      field('IMEI', { required: true, regex: '^[0-9]{15}$', isMainInput: true }),
      field('Carrier', { label: 'Carrier name', fieldType: 'select', options: ['att', 'tmo'] }),
    ]);
    expect(first.status).toBe(200);
    expect(first.body).toEqual([
      saved('imei', 'IMEI', { required: true, regex: '^[0-9]{15}$', isMainInput: true }),
      saved('carrier', 'Carrier', { label: 'Carrier name', fieldType: 'select', options: ['att', 'tmo'] }),
    ]);
    const second = await putFields([field('Note', { fieldType: 'textarea' }), field('IMEI', { key: 'imei' })]);
    expect(second.status).toBe(200);
    expect(second.body.map((f: { key: string }) => f.key)).toEqual(['note', 'imei']);
    const rows = await storedFields();
    expect(rows.map((r) => [r.key, r.supplierKey, r.sort])).toEqual([
      ['note', 'Note', 0],
      ['imei', 'IMEI', 1],
    ]);
    expect((await admin.get(`/admin/services/${serviceId}`)).body.fields).toEqual(second.body);

    const audits = await auditRows();
    expect(audits[1]).toMatchObject({
      action: 'replaced custom fields of service',
      entityType: 'service',
      entityId: serviceId,
      entityLabel: 'AT&T Unlock',
    });
    // Each field by key, Name, label, required and the main-input flag: what a supplier and a buyer see, and what travels as the IMEI.
    expect(audits[1]!.before).toEqual({
      fields: [
        { key: 'imei', name: 'IMEI', label: 'IMEI', required: true, isMainInput: true },
        { key: 'carrier', name: 'Carrier', label: 'Carrier name', required: false, isMainInput: false },
      ],
    });
    expect(audits[1]!.after).toEqual({
      fields: [
        { key: 'note', name: 'Note', label: 'Note', required: false, isMainInput: false },
        { key: 'imei', name: 'IMEI', label: 'IMEI', required: false, isMainInput: true },
      ],
    });
  });

  it('clears the list with an empty one', async () => {
    await putFields([field('A')]);
    const res = await putFields([]);
    expect(res.body).toEqual([]);
    expect(await (await testDb()).db.select().from(s.serviceFields)).toEqual([]);
  });

  it('makes the key of a new field from its Name, with a number on a clash and field when nothing is left', async () => {
    const res = await putFields([
      field('User-Name'),
      field('User Name'),
      field(' Serial No. '),
      field('###'),
      field('***'),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.map((f: { key: string; name: string }) => [f.key, f.name])).toEqual([
      ['user_name', 'User-Name'],
      ['user_name_2', 'User Name'],
      ['serial_no', 'Serial No.'],
      ['field', '###'],
      ['field_2', '***'],
    ]);
  });

  it('keeps the key of a saved field when its Name changes, and its label, flag and answer when the row leaves them out', async () => {
    await putFields([
      field('IMEI', { label: 'Phone IMEI', isMainInput: true }),
      field('Account', { label: 'Account name' }),
    ]);
    const res = await putFields([field('IMEI number', { key: 'imei' }), field('Account user', { key: 'account' })]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      saved('imei', 'IMEI number', { label: 'Phone IMEI', isMainInput: true }),
      saved('account', 'Account user', { label: 'Account name' }),
    ]);
  });

  it('stores the Name for an empty label, the typed label otherwise, and turns the flag off when it is sent false', async () => {
    await putFields([
      field('Serial', { label: 'Phone serial', isMainInput: true }),
      field('Account', { label: 'Account' }),
    ]);
    const res = await putFields([
      field('Serial', { key: 'serial', label: '', isMainInput: false }),
      field('Account', { key: 'account', label: ' Your account ' }),
      field('Note', { label: '  ' }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      saved('serial', 'Serial'),
      saved('account', 'Account', { label: 'Your account' }),
      saved('note', 'Note'),
    ]);
  });

  it('flags the first field named IMEI in any letter case on an IMEI service when the save leaves none flagged', async () => {
    const res = await putFields([field('Model'), field(' imei '), field('IMEI 2')]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      saved('model', 'Model'),
      saved('imei', 'imei', { isMainInput: true }),
      saved('imei_2', 'IMEI 2'),
    ]);
    // Turning the flag off on that field leaves it on: on an IMEI service it is the IMEI.
    const off = await putFields([field('IMEI', { key: 'imei', isMainInput: false })]);
    expect(off.body).toEqual([saved('imei', 'IMEI', { label: 'imei', isMainInput: true })]);
    // Another field that is flagged keeps the flag.
    const other = await putFields([
      field('Serial', { isMainInput: true }),
      field('IMEI', { key: 'imei', isMainInput: false }),
    ]);
    expect(other.body.map((f: { key: string; isMainInput: boolean }) => [f.key, f.isMainInput])).toEqual([
      ['serial', true],
      ['imei', false],
    ]);
  });

  it('flags no field by its Name on a service of another type', async () => {
    const { db } = await testDb();
    const server = await insertService(db, await insertCategory(db, { type: 'server' }), { type: 'server' });
    const res = await admin.put(`/admin/services/${server}/fields`, { fields: [field('IMEI'), field('Model')] });
    expect(res.status).toBe(200);
    expect(res.body.map((f: { isMainInput: boolean }) => f.isMainInput)).toEqual([false, false]);
  });

  it('does not hand the key of a deleted field to a new field in the same save', async () => {
    await putFields([field('Account')]);
    const res = await putFields([field('Account'), field('Other')]);
    expect(res.body.map((f: { key: string }) => f.key)).toEqual(['account_2', 'other']);
  });

  it('refuses an unknown key and a repeated key on fields.N.key, and stores nothing', async () => {
    await putFields([field('A'), field('B')]);
    const unknown = await putFields([field('A', { key: 'a' }), field('X', { key: 'x' })]);
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors).toEqual([
      expect.objectContaining({ field: 'fields.1.key', message: 'This field no longer exists. Reload the page.' }),
    ]);
    const repeated = await putFields([field('A', { key: 'a' }), field('B', { key: 'b' }), field('C', { key: 'a' })]);
    expect(repeated.status).toBe(422);
    expect(repeated.body.errors).toEqual([
      expect.objectContaining({ field: 'fields.2.key', message: 'The key a is used twice.' }),
    ]);
    expect((await storedFields()).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('refuses a Name that an earlier field has, ignoring letter case, on the later row', async () => {
    const res = await putFields([field('Email'), field('Phone'), field('email')]);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ field: 'fields.2.name', message: 'The name email is used by an earlier field.' }),
    ]);
    expect(await storedFields()).toEqual([]);
  });

  it('answers a repeated Name on the database fallback when the code and Postgres fold a letter differently', async () => {
    const { db } = await testDb();
    const folded = await db.execute<{ same: boolean }>(sql`select lower('\u0130') = 'i' as same`);
    // The dotted capital I folds to a plain i in a UTF-8 locale of Postgres and to two characters in JavaScript; in the C locale
    // nothing folds and the code has the last word, so there is nothing to see.
    if (!folded.rows[0]?.same) return;
    const res = await putFields([field('i'), field('Other'), field('\u0130')]);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'fields.2.name' })]);
    expect(await storedFields()).toEqual([]);
  });

  it('refuses a second main input on fields.N.isMainInput, also one that a saved field has and the row leaves unsaid', async () => {
    const two = await putFields([field('A', { isMainInput: true }), field('B'), field('C', { isMainInput: true })]);
    expect(two.status).toBe(422);
    expect(errorFields(two)).toEqual(['fields.2.isMainInput']);
    await putFields([field('IMEI', { isMainInput: true }), field('Serial')]);
    const kept = await putFields([
      field('IMEI', { key: 'imei' }),
      field('Serial', { key: 'serial', isMainInput: true }),
    ]);
    expect(kept.status).toBe(422);
    expect(errorFields(kept)).toEqual(['fields.1.isMainInput']);
    const moved = await putFields([
      field('IMEI', { key: 'imei', isMainInput: false }),
      field('Serial', { key: 'serial', isMainInput: true }),
    ]);
    expect(moved.status).toBe(200);
    expect(moved.body.map((f: { isMainInput: boolean }) => f.isMainInput)).toEqual([false, true]);
  });

  it('names every other problem on its dotted path', async () => {
    const bad = await putFields([
      field(' ', {}),
      field('B', { label: 'x'.repeat(121) }),
      field('C', { fieldType: 'date' }),
      field('D', { key: ' ' }),
      { fieldType: 'text', required: false, options: [], regex: '' },
    ]);
    expect(bad.status).toBe(422);
    expect(errorFields(bad).sort()).toEqual([
      'fields.0.name',
      'fields.1.label',
      'fields.2.fieldType',
      'fields.3.key',
      'fields.4.name',
    ]);
    const pattern = await putFields([field('D', { regex: '([0-9' })]);
    expect(pattern.body.errors).toEqual([expect.objectContaining({ field: 'fields.0.regex' })]);
    // Nothing was changed by the refused calls.
    expect(await (await testDb()).db.select().from(s.serviceFields)).toEqual([]);
  });

  it('refuses a pattern outside the supported form with its reason, and saves one inside it', async () => {
    const nested = await putFields([field('D', { regex: '^(a+)+$' })]);
    expect(nested.status).toBe(422);
    expect(nested.body.errors).toEqual([
      expect.objectContaining({ field: 'fields.0.regex', message: FIELD_PATTERN_MESSAGES.nested }),
    ]);
    const complex = await putFields([field('ok'), field('D', { regex: '\\d+\\d+$' })]);
    expect(complex.body.errors).toEqual([
      expect.objectContaining({ field: 'fields.1.regex', message: FIELD_PATTERN_MESSAGES.too_complex }),
    ]);
    // Nothing was stored by the refused calls.
    expect(await (await testDb()).db.select().from(s.serviceFields)).toEqual([]);

    const ok = await putFields([field('D', { regex: '^[A-Z]{2}\\d{4}$' })]);
    expect(ok.status).toBe(200);
    expect(ok.body[0]).toMatchObject({ key: 'd', regex: '^[A-Z]{2}\\d{4}$' });
  });

  it('trims Names and keys, so a Name repeated after trimming is a duplicate', async () => {
    const res = await putFields([field('a'), field(' a ')]);
    expect(res.body.errors[0]).toMatchObject({ field: 'fields.1.name' });
    await putFields([field('a')]);
    const key = await putFields([field('a', { key: ' a ' })]);
    expect(key.status).toBe(200);
    expect(key.body[0]).toMatchObject({ key: 'a', name: 'a' });
  });

  it('answers 404 for an unknown service and needs catalog:update', async () => {
    expect((await admin.put('/admin/services/999999/fields', { fields: [] })).status).toBe(404);
    const other = await adminWith(t, ['catalog:read', 'catalog:create']);
    expect((await other.put(`/admin/services/${serviceId}/fields`, { fields: [] })).status).toBe(403);
  });

  it('serialises two saves of the same service: the last one wins and no row is lost or doubled', async () => {
    const results = await Promise.all([
      putFields([field('A'), field('B')]),
      putFields([field('B'), field('C'), field('D')]),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await storedFields();
    expect(rows.length === 2 || rows.length === 3).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.supplierKey.toLowerCase())).size).toBe(rows.length);
  });
});

describe('PUT /admin/services/:id/options (retired, decision 072)', () => {
  const body = { options: [{ list: 'model', value: 'iphone15', label: 'iPhone 15', supplierValue: '' }] };

  it('answers 404 to staff with every permission, writes nothing and emits no search event', async () => {
    const { db } = await testDb();
    const events = (await db.select().from(s.outboxEvents)).length;
    const audits = (await auditRows()).length;
    expect((await admin.put(`/admin/services/${serviceId}/options`, body)).status).toBe(404);
    expect((await admin.put(`/admin/services/${serviceId}/options`, { options: [] })).status).toBe(404);
    expect((await admin.put('/admin/services/999999/options', body)).status).toBe(404);
    expect(await db.select().from(s.serviceOptions)).toEqual([]);
    expect((await auditRows()).length).toBe(audits);
    expect((await db.select().from(s.outboxEvents)).length).toBe(events);
  });

  it('answers 404, not 401, to a caller with no session: nothing serves the path', async () => {
    expect((await admin.anonymous('PUT', `/admin/services/${serviceId}/options`, body)).status).toBe(404);
  });

  it('still shows the lists already stored in the options of the service', async () => {
    const { db } = await testDb();
    await db.insert(s.serviceOptions).values([
      { serviceId, list: 'model', value: 'iphone15', label: 'iPhone 15' },
      { serviceId, list: 'network', value: 'att', label: 'AT&T USA', supplierValue: 'ATT' },
    ]);
    const shown = await admin.get(`/admin/services/${serviceId}`);
    expect(shown.status).toBe(200);
    expect(shown.body.options).toEqual([
      { list: 'model', value: 'iphone15', label: 'iPhone 15', supplierValue: '' },
      { list: 'network', value: 'att', label: 'AT&T USA', supplierValue: 'ATT' },
    ]);
  });
});
