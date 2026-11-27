// Decision 076: ten more custom field types. The fields save (PUT /admin/services/:id/fields) accepts every value of SERVICE_FIELD_TYPES
// and every read answers it (the admin detail, the portal's GET /client/services/:id), the check service_fields_field_type_check of
// migration 0073 takes each and refuses an unknown one, and our Dhru list (imeiservicelist) shows an imei_bulk field as a textarea and
// every other new type as text. Real application, Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { SERVICE_FIELD_TYPES } from '@src/modules/catalog/db/schema';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearApiKeyCaches, credentialsFor, dhruClient } from '../../support/machine-orders';
import { type OrdersWorld, json, ordersWorld, portalFor } from '../../support/orders';

let t: TestApp;
let world: OrdersWorld;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  const { db } = await testDb();
  world = await ordersWorld(db);
  admin = await adminWith(t, ['catalog:*'], { name: 'Rami K.' });
});

/** One field of each type, its Name the type's own name (the key is made from it). */
const everyType = () =>
  SERVICE_FIELD_TYPES.map((fieldType) => ({
    name: fieldType,
    fieldType,
    required: false,
    options: fieldType === 'select' ? ['one', 'two'] : [],
    regex: '',
  }));

describe('PUT /admin/services/:id/fields with the ten new types (decision 076)', () => {
  it('saves a field of every type and every read answers it', async () => {
    const saved = await admin.put(`/admin/services/${world.server.serviceId}/fields`, { fields: everyType() });
    expect(saved.status).toBe(200);
    expect(saved.body.map((field: { fieldType: string }) => field.fieldType)).toEqual([...SERVICE_FIELD_TYPES]);
    const detail = await admin.get(`/admin/services/${world.server.serviceId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.fields.map((field: { fieldType: string }) => field.fieldType)).toEqual([...SERVICE_FIELD_TYPES]);
    const rows = await world.db.select({ fieldType: s.serviceFields.fieldType }).from(s.serviceFields);
    expect(rows.map((row) => row.fieldType).sort()).toEqual([...SERVICE_FIELD_TYPES].sort());
    // The audit row of the save names each field's type.
    const [audit] = await world.db
      .select()
      .from(s.auditLogs)
      .where(sql`${s.auditLogs.action} = 'replaced custom fields of service'`);
    expect((audit!.after as { fields: Array<{ fieldType: string }> }).fields.map((field) => field.fieldType)).toEqual([
      ...SERVICE_FIELD_TYPES,
    ]);

    const portal = await portalFor(t, world.merchant.id);
    const form = await portal.get(`/client/services/${world.server.serviceId}`);
    expect(form.statusCode).toBe(200);
    expect(json(form).fields.map((field: { fieldType: string }) => field.fieldType)).toEqual([...SERVICE_FIELD_TYPES]);
  });

  it('refuses a type the list does not have, in the request and in the database check', async () => {
    const refused = await admin.put(`/admin/services/${world.server.serviceId}/fields`, {
      fields: [{ name: 'Lock', fieldType: 'frp_lock', required: false, options: [], regex: '' }],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.errors.map((error: { field: string }) => error.field)).toEqual(['fields.0.fieldType']);
    const failure: unknown = await world.db
      .insert(s.serviceFields)
      .values({
        serviceId: world.server.serviceId,
        key: 'lock',
        label: 'Lock',
        supplierKey: 'Lock',
        fieldType: 'frp_lock' as never,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const cause = (failure as { cause?: { constraint?: string } } | undefined)?.cause;
    expect(cause?.constraint).toBe('service_fields_field_type_check');
    const [check] = (
      await world.db.execute<{ definition: string }>(
        sql`select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'service_fields_field_type_check'`,
      )
    ).rows;
    for (const fieldType of SERVICE_FIELD_TYPES) expect(check!.definition).toContain(`'${fieldType}'`);
  });
});

describe('imeiservicelist with the ten new types (decision 076)', () => {
  it('lists an imei_bulk field as a textarea and every other new type as text', async () => {
    await admin.put(`/admin/services/${world.server.serviceId}/fields`, { fields: everyType() });
    const creds = await credentialsFor(t, world.db, world.merchant.id);
    const answer = await dhruClient(t, creds).call('imeiservicelist');
    const custom: Array<{ fieldname: string; fieldtype: string }> =
      answer.SUCCESS[0].LIST['Server credits'].SERVICES[String(world.server.serviceId)]['Requires.Custom'];
    expect(Object.fromEntries(custom.map((field) => [field.fieldname, field.fieldtype]))).toEqual({
      text: 'text',
      number: 'text',
      select: 'dropdown',
      textarea: 'textarea',
      imei: 'text',
      imei_bulk: 'textarea',
      imeisv: 'text',
      serial: 'text',
      iccid: 'text',
      eid: 'text',
      meid: 'text',
      ecid: 'text',
      mac_address: 'text',
      mi_lock_code: 'text',
      box_sn: 'text',
    });
  });
});
