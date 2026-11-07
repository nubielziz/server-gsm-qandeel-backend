// Integration tests of the replace-all lists of a service (feature 4a): PUT /admin/services/:id/fields and /options.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';

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

const field = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  label: key.toUpperCase(),
  fieldType: 'text',
  required: false,
  options: [],
  regex: '',
  supplierKey: '',
  ...extra,
});
const option = (list: string, value: string, extra: Record<string, unknown> = {}) => ({
  list,
  value,
  label: value,
  supplierValue: '',
  ...extra,
});

describe('PUT /admin/services/:id/fields', () => {
  it('replaces the list in order, deletes what is left out, answers the saved list and audits it', async () => {
    const first = await admin.put(`/admin/services/${serviceId}/fields`, {
      fields: [
        field('imei', { required: true, regex: '^[0-9]{15}$', supplierKey: 'IMEI' }),
        field('carrier', { fieldType: 'select', options: ['att', 'tmo'] }),
      ],
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual([
      {
        key: 'imei',
        label: 'IMEI',
        fieldType: 'text',
        required: true,
        options: [],
        regex: '^[0-9]{15}$',
        supplierKey: 'IMEI',
      },
      {
        key: 'carrier',
        label: 'CARRIER',
        fieldType: 'select',
        required: false,
        options: ['att', 'tmo'],
        regex: '',
        supplierKey: '',
      },
    ]);
    const second = await admin.put(`/admin/services/${serviceId}/fields`, {
      fields: [field('note', { fieldType: 'textarea' }), field('imei')],
    });
    expect(second.body.map((f: { key: string }) => f.key)).toEqual(['note', 'imei']);
    const { db } = await testDb();
    const rows = await db
      .select()
      .from(s.serviceFields)
      .where(eq(s.serviceFields.serviceId, serviceId))
      .orderBy(s.serviceFields.sort);
    expect(rows.map((r) => [r.key, r.sort])).toEqual([
      ['note', 0],
      ['imei', 1],
    ]);
    expect((await admin.get(`/admin/services/${serviceId}`)).body.fields.map((f: { key: string }) => f.key)).toEqual([
      'note',
      'imei',
    ]);

    const audits = await auditRows();
    expect(audits[1]).toMatchObject({
      action: 'replaced custom fields of service',
      entityType: 'service',
      entityId: serviceId,
      entityLabel: 'AT&T Unlock',
    });
    expect(audits[1]!.before).toEqual({ fields: ['imei', 'carrier'] });
    expect(audits[1]!.after).toEqual({ fields: ['note', 'imei'] });
  });

  it('clears the list with an empty one', async () => {
    await admin.put(`/admin/services/${serviceId}/fields`, { fields: [field('a')] });
    const res = await admin.put(`/admin/services/${serviceId}/fields`, { fields: [] });
    expect(res.body).toEqual([]);
    expect(await (await testDb()).db.select().from(s.serviceFields)).toEqual([]);
  });

  it('names the later occurrence of a repeated key and every other problem on its dotted path', async () => {
    const dup = await admin.put(`/admin/services/${serviceId}/fields`, {
      fields: [field('a'), field('b'), field('a')],
    });
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toEqual([
      expect.objectContaining({ field: 'fields.2.key', message: 'The key a is used twice.' }),
    ]);

    const bad = await admin.put(`/admin/services/${serviceId}/fields`, {
      fields: [
        field(' ', {}),
        field('b', { label: '  ' }),
        field('c', { fieldType: 'date' }),
        field('d', { regex: '([0-9' }),
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'fields.0.key',
      'fields.0.label',
      'fields.1.label',
      'fields.2.fieldType',
    ]);
    const pattern = await admin.put(`/admin/services/${serviceId}/fields`, {
      fields: [field('d', { regex: '([0-9' })],
    });
    expect(pattern.body.errors).toEqual([expect.objectContaining({ field: 'fields.0.regex' })]);
    // Nothing was changed by the refused calls.
    expect(await (await testDb()).db.select().from(s.serviceFields)).toEqual([]);
  });

  it('trims keys, so a key repeated after trimming is a duplicate', async () => {
    const res = await admin.put(`/admin/services/${serviceId}/fields`, { fields: [field('a'), field(' a ')] });
    expect(res.body.errors[0]).toMatchObject({ field: 'fields.1.key' });
  });

  it('answers 404 for an unknown service and needs catalog:update', async () => {
    expect((await admin.put('/admin/services/999999/fields', { fields: [] })).status).toBe(404);
    const other = await adminWith(t, ['catalog:read', 'catalog:create']);
    expect((await other.put(`/admin/services/${serviceId}/fields`, { fields: [] })).status).toBe(403);
  });

  it('serialises two saves of the same service: the last one wins and no row is lost or doubled', async () => {
    const results = await Promise.all([
      admin.put(`/admin/services/${serviceId}/fields`, { fields: [field('a'), field('b')] }),
      admin.put(`/admin/services/${serviceId}/fields`, { fields: [field('b'), field('c'), field('d')] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await (
      await testDb()
    ).db
      .select()
      .from(s.serviceFields)
      .where(eq(s.serviceFields.serviceId, serviceId));
    expect(rows.length === 2 || rows.length === 3).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('PUT /admin/services/:id/options', () => {
  it('replaces all three lists in order and answers the saved list', async () => {
    const res = await admin.put(`/admin/services/${serviceId}/options`, {
      options: [
        option('model', 'iphone15', { label: 'iPhone 15' }),
        option('network', 'att', { label: 'AT&T USA', supplierValue: 'ATT' }),
        option('model', 'iphone14', { label: 'iPhone 14' }),
        option('mep', '1', { label: 'MEP 1' }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { list: 'model', value: 'iphone15', label: 'iPhone 15', supplierValue: '' },
      { list: 'network', value: 'att', label: 'AT&T USA', supplierValue: 'ATT' },
      { list: 'model', value: 'iphone14', label: 'iPhone 14', supplierValue: '' },
      { list: 'mep', value: '1', label: 'MEP 1', supplierValue: '' },
    ]);
    expect((await admin.get(`/admin/services/${serviceId}`)).body.options).toEqual(res.body);

    const smaller = await admin.put(`/admin/services/${serviceId}/options`, { options: [option('network', 'tmo')] });
    expect(smaller.body).toEqual([{ list: 'network', value: 'tmo', label: 'tmo', supplierValue: '' }]);
    const audits = await auditRows();
    expect(audits[1]).toMatchObject({ action: 'replaced option lists of service', entityId: serviceId });
    expect(audits[1]!.before).toEqual({ model: 2, network: 1, mep: 1 });
    expect(audits[1]!.after).toEqual({ model: 0, network: 1, mep: 0 });
  });

  it('keeps a list of hundreds of entries in order', async () => {
    const options = Array.from({ length: 1200 }, (_, i) => option('model', `model-${String(i).padStart(4, '0')}`));
    const res = await admin.put(`/admin/services/${serviceId}/options`, { options });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1200);
    const read = (await admin.get(`/admin/services/${serviceId}`)).body.options as Array<{ value: string }>;
    expect(read.map((o) => o.value)).toEqual(options.map((o) => o.value));
  });

  it('names the later occurrence of a value repeated within a list, and allows it in another list', async () => {
    const dup = await admin.put(`/admin/services/${serviceId}/options`, {
      options: [option('model', 'x'), option('network', 'x'), option('model', ' x ')],
    });
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toEqual([
      expect.objectContaining({ field: 'options.2.value', message: 'Duplicate in the model list' }),
    ]);
    expect(await (await testDb()).db.select().from(s.serviceOptions)).toEqual([]);
  });

  it('refuses an unknown list and an empty value on the dotted path', async () => {
    const res = await admin.put(`/admin/services/${serviceId}/options`, {
      options: [option('colour', 'red'), option('model', '   ')],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'options.0.list',
      'options.1.value',
    ]);
  });

  it('answers 404 for an unknown service and needs catalog:update', async () => {
    expect((await admin.put('/admin/services/999999/options', { options: [] })).status).toBe(404);
    const other = await adminWith(t, ['catalog:read']);
    expect((await other.put(`/admin/services/${serviceId}/options`, { options: [] })).status).toBe(403);
  });
});
