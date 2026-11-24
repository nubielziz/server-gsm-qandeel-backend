// One Name per custom field (backend decision 065), migration `_field_names.sql`, on a database held right before it and filled with the
// shapes stored fields have: the first field a service sends as the IMEI parameter becomes its main input and gets a real Name (its
// label when free, else its key), so does the field keyed imei on an IMEI service without one, an empty Name becomes the key, Names are trimmed, a repeated Name (ignoring case) is numbered on the
// later field (never on a field a supplier receives by Name when the main input is the other), keys and stored order answers are
// unchanged, and the three new rules refuse a bad row afterwards.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import { FIELD_NAMES_SUFFIX, ScratchDatabases, migrateUntil, poolOn } from '../../support/migration-files';

setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('fieldnames');
let url = '';
let pool: Pool;
const categoryOf: Record<string, number> = {};
let serviceCount = 0;

beforeAll(async () => {
  const db = await scratch.create();
  url = db.url;
  await migrateUntil(url, FIELD_NAMES_SUFFIX);
  pool = poolOn(url);
  for (const type of ['imei', 'server']) {
    const { rows } = await pool.query<{ id: string }>(
      'insert into service_categories (name, type) values ($1, $2) returning id',
      [`Field names ${type}`, type],
    );
    categoryOf[type] = Number(rows[0]!.id);
  }
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await scratch.dropAll();
});

/** One stored field of the old shape: its key, label, supplier key and form position. */
type OldField = readonly [key: string, label: string, supplierKey: string, sort: number];

/** Inserts a service of a type with fields of the old shape, in the order given (so ids can disagree with the form order). */
async function serviceWith(type: 'imei' | 'server', fields: readonly OldField[]): Promise<number> {
  serviceCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into services (category_id, type, name, fulfillment, base_price, code, sla_minutes)
     values ($1, $2, $3, 'manual', 5, $4, 60) returning id`,
    [categoryOf[type], type, `Field names ${serviceCount}`, `FN-${serviceCount}`],
  );
  const serviceId = Number(rows[0]!.id);
  for (const [key, label, supplierKey, sort] of fields) {
    await pool.query(
      'insert into service_fields (service_id, key, label, supplier_key, sort) values ($1, $2, $3, $4, $5)',
      [serviceId, key, label, supplierKey, sort],
    );
  }
  return serviceId;
}

/** The fields of a service after the migration, in form order: key, Name and main-input flag. */
async function fieldsOf(serviceId: number): Promise<Array<[string, string, boolean]>> {
  const { rows } = await pool.query<{ key: string; supplier_key: string; is_main_input: boolean }>(
    'select key, supplier_key, is_main_input from service_fields where service_id = $1 order by sort, id',
    [serviceId],
  );
  return rows.map((row) => [row.key, row.supplier_key, row.is_main_input]);
}

describe('the stored fields', () => {
  const ids: Record<string, number> = {};
  let orderId = 0;
  let inputsBefore: unknown;

  beforeAll(async () => {
    ids.freeLabel = await serviceWith('server', [
      ['serial_number', 'Serial Number', 'IMEI', 0],
      ['note', 'Note', '  Note  ', 1],
    ]);
    ids.takenLabel = await serviceWith('server', [
      ['lock_code', 'Account', 'imei', 0],
      ['account', 'Account', 'account', 1],
    ]);
    ids.keyedImei = await serviceWith('imei', [
      ['imei', 'IMEI', '', 0],
      ['model', 'Model', '', 1],
    ]);
    // A supplier name that is not IMEI but gives the key imei: the old placement read that key as the IMEI on an IMEI service.
    ids.keyedImeiNamed = await serviceWith('imei', [
      ['model', 'Model', 'Model', 0],
      ['imei', 'IMEI', 'IMEI:', 1],
    ]);
    // The same field beside a field the dispatch sends as the IMEI: that one is the main input, the field keyed imei stays ordinary.
    ids.keyedImeiBeside = await serviceWith('imei', [
      ['serial', 'Serial', 'IMEI', 0],
      ['imei', 'Device IMEI', 'IMEI:', 1],
    ]);
    // On a service of another type the key says nothing.
    ids.keyedImeiServer = await serviceWith('server', [['imei', 'IMEI', 'IMEI:', 0]]);
    // The later row by the form order is inserted first: the form order decides, not the id.
    ids.twoImei = await serviceWith('server', [
      ['imei', 'IMEI', 'IMEI', 1],
      ['lock_code', 'Lock code', 'IMEI', 0],
    ]);
    ids.repeated = await serviceWith('server', [
      ['mail', 'Mail', 'EMAIL', 2],
      ['email', 'Email', 'Email', 0],
      ['contact', 'Contact', 'email', 1],
      ['username', 'Username', '', 3],
    ]);
    ids.boxClash = await serviceWith('server', [
      ['serial', 'Serial', 'IMEI', 0],
      ['sn', 'SN', 'Serial', 1],
    ]);
    ids.long = await serviceWith('server', [
      ['a', 'A', 'x'.repeat(120), 0],
      ['b', 'B', 'X'.repeat(120), 1],
    ]);

    const { rows: groups } = await pool.query<{ id: string }>(
      `insert into client_groups (name, kind) values ('Field names', 'b2b') returning id`,
    );
    await pool.query(
      `insert into currencies (code, name, rate_to_base, decimals) values ('USD', 'US dollar', 1, 2) on conflict do nothing`,
    );
    const { rows: clients } = await pool.query<{ id: string }>(
      `insert into clients (username, email, name, group_id, referral_code)
       values ('field-names', 'field-names@example.test', 'Field names', $1, 'FN-REF') returning id`,
      [groups[0]!.id],
    );
    const clientId = clients[0]!.id;
    const { rows: orders } = await pool.query<{ id: string; inputs: unknown }>(
      `insert into orders (service_id, type, source, account_id, client_id, unit_price, total_price, currency, inputs)
       values ($1, 'imei', 'dhru', $2, $2, 1, 1, 'USD', $3) returning id, inputs`,
      [ids.keyedImei, clientId, JSON.stringify({ imei: '352905112490861', model: 'iPhone 15' })],
    );
    orderId = Number(orders[0]!.id);
    inputsBefore = orders[0]!.inputs;

    await migrateDatabase(url);
  });

  it('flags the main box and names it after its label when that is free; trims a Name', async () => {
    expect(await fieldsOf(ids.freeLabel!)).toEqual([
      ['serial_number', 'Serial Number', true],
      ['note', 'Note', false],
    ]);
  });

  it('names the main box after its key when another field has its label as Name', async () => {
    expect(await fieldsOf(ids.takenLabel!)).toEqual([
      ['lock_code', 'lock_code', true],
      ['account', 'account', false],
    ]);
  });

  it('flags a field keyed imei with no supplier key, and gives an empty Name the key', async () => {
    expect(await fieldsOf(ids.keyedImei!)).toEqual([
      ['imei', 'IMEI', true],
      ['model', 'model', false],
    ]);
  });

  it('flags a field keyed imei whatever its supplier key on an IMEI service that has no other main input, and only there', async () => {
    expect(await fieldsOf(ids.keyedImeiNamed!)).toEqual([
      ['model', 'Model', false],
      ['imei', 'IMEI', true],
    ]);
    expect(await fieldsOf(ids.keyedImeiBeside!)).toEqual([
      ['serial', 'Serial', true],
      ['imei', 'IMEI:', false],
    ]);
    expect(await fieldsOf(ids.keyedImeiServer!)).toEqual([['imei', 'IMEI:', false]]);
  });

  it('flags only the first IMEI row by the form order; a later one keeps the Name IMEI as an ordinary field', async () => {
    expect(await fieldsOf(ids.twoImei!)).toEqual([
      ['lock_code', 'Lock code', true],
      ['imei', 'IMEI', false],
    ]);
  });

  it('numbers a repeated Name on the later fields by the form order, ignoring case', async () => {
    expect(await fieldsOf(ids.repeated!)).toEqual([
      ['email', 'Email', false],
      ['contact', 'email 2', false],
      ['mail', 'EMAIL 3', false],
      ['username', 'username', false],
    ]);
  });

  it('numbers the main input, not a field a supplier receives by Name, when the two clash', async () => {
    expect(await fieldsOf(ids.boxClash!)).toEqual([
      ['serial', 'serial 2', true],
      ['sn', 'Serial', false],
    ]);
  });

  it('cuts a numbered Name so it stays at most 120 characters', async () => {
    expect(await fieldsOf(ids.long!)).toEqual([
      ['a', 'x'.repeat(120), false],
      ['b', `${'X'.repeat(118)} 2`, false],
    ]);
  });

  it('leaves a stored order and its answers by key as they were', async () => {
    const { rows } = await pool.query<{ inputs: unknown }>('select inputs from orders where id = $1', [orderId]);
    expect(rows[0]!.inputs).toEqual(inputsBefore);
  });

  it('refuses an empty Name, a Name repeated in another case and a second main input afterwards', async () => {
    const insert = (key: string, name: string, main = false) =>
      pool
        .query(
          'insert into service_fields (service_id, key, label, supplier_key, is_main_input) values ($1, $2, $2, $3, $4)',
          [ids.freeLabel, key, name, main],
        )
        .then(
          () => 'inserted',
          (error: { constraint?: string }) => error.constraint ?? 'no constraint',
        );
    expect(await insert('blank', '  ')).toBe('service_fields_supplier_key_check');
    expect(await insert('note_2', 'NOTE')).toBe('service_fields_name_uq');
    expect(await insert('imei', 'IMEI', true)).toBe('service_fields_main_input_uq');
    expect(await insert('imei', 'IMEI')).toBe('inserted');
  });
});

describe('an empty database', () => {
  it('runs with no field to change', async () => {
    const db = await scratch.create();
    expect(await migrateDatabase(db.url)).toBeGreaterThan(0);
  });
});
