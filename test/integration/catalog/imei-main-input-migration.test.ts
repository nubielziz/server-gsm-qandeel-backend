// The IMEI field of a plain IMEI service (backend decision 071), migration `_imei_main_input_field.sql`, on a database held right before it
// and filled with the shapes stored IMEI services have: a service with no main-input field gets the field `IMEI` first (key `imei`, else
// the first free of `imei_2`, `imei_3`, ...), its own fields moved down by one; a field already named IMEI in another letter case is
// flagged instead and nothing is inserted; a service that has a main-input field and a service of another type are not touched; running
// the statements again changes nothing, and the migration runs on an empty database.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import {
  IMEI_FIELD_TYPE_SUFFIX,
  IMEI_MAIN_INPUT_SUFFIX,
  ScratchDatabases,
  migrateUntil,
  migrationStatements,
  poolOn,
} from '../../support/migration-files';

setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('imeifield');
let url = '';
let pool: Pool;
const categoryOf: Record<string, number> = {};
let serviceCount = 0;

beforeAll(async () => {
  const db = await scratch.create();
  url = db.url;
  await migrateUntil(url, IMEI_MAIN_INPUT_SUFFIX);
  pool = poolOn(url);
  for (const type of ['imei', 'server']) {
    const { rows } = await pool.query<{ id: string }>(
      'insert into service_categories (name, type) values ($1, $2) returning id',
      [`IMEI field ${type}`, type],
    );
    categoryOf[type] = Number(rows[0]!.id);
  }
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await scratch.dropAll();
});

/** One stored field: its key, Name, form position and main-input flag (the label is the Name). */
type StoredField = readonly [key: string, name: string, sort: number, isMainInput?: boolean];

/** Inserts a service of a type, optionally archived, with fields in the order given (so ids can disagree with the form order). */
async function serviceWith(
  type: 'imei' | 'server',
  fields: readonly StoredField[],
  options: { archived?: boolean } = {},
): Promise<number> {
  serviceCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into services (category_id, type, name, fulfillment, base_price, code, sla_minutes, status, archived_at)
     values ($1, $2, $3, 'auto', 5, $4, 60, $5, $6) returning id`,
    [
      categoryOf[type],
      type,
      `IMEI field ${serviceCount}`,
      `IF-${serviceCount}`,
      options.archived ? 'disabled' : 'active',
      options.archived ? new Date() : null,
    ],
  );
  const serviceId = Number(rows[0]!.id);
  for (const [key, name, sort, isMainInput = false] of fields) {
    await pool.query(
      `insert into service_fields (service_id, key, label, supplier_key, sort, is_main_input, required)
       values ($1, $2, $3, $3, $4, $5, false)`,
      [serviceId, key, name, sort, isMainInput],
    );
  }
  return serviceId;
}

/** The fields of a service in form order: key, Name, sort and main-input flag. */
async function fieldsOf(serviceId: number): Promise<Array<[string, string, number, boolean]>> {
  const { rows } = await pool.query<{ key: string; supplier_key: string; sort: number; is_main_input: boolean }>(
    'select key, supplier_key, sort, is_main_input from service_fields where service_id = $1 order by sort, id',
    [serviceId],
  );
  return rows.map((row) => [row.key, row.supplier_key, row.sort, row.is_main_input]);
}

/** Every stored field with all its columns, for the comparisons that must find nothing changed. */
async function everyField(serviceIds?: readonly number[]): Promise<unknown[]> {
  const { rows } = await pool.query(
    serviceIds === undefined
      ? 'select * from service_fields order by id'
      : 'select * from service_fields where service_id = any($1::bigint[]) order by id',
    serviceIds === undefined ? [] : [serviceIds],
  );
  return rows;
}

describe('the stored IMEI services', () => {
  const ids: Record<string, number> = {};
  let untouchedBefore: unknown[] = [];

  beforeAll(async () => {
    ids.plain = await serviceWith('imei', [
      ['note', 'Note', 1],
      ['model', 'Model', 0],
    ]);
    ids.bare = await serviceWith('imei', []);
    ids.archived = await serviceWith('imei', [['model', 'Model', 0]], { archived: true });
    // A field named IMEI in another letter case is the IMEI itself: it is flagged, nothing is inserted.
    ids.namedLower = await serviceWith('imei', [
      ['model', 'Model', 0],
      ['device', 'imei', 1],
    ]);
    // A key clash: the key imei is taken by a field whose Name is not IMEI, so the new field takes the first free number.
    ids.keyTaken = await serviceWith('imei', [['imei', 'IMEI:', 0]]);
    ids.twoKeysTaken = await serviceWith('imei', [
      ['imei_2', 'Second', 0],
      ['imei', 'IMEI no.', 1],
    ]);
    // Not touched: a service that already has a main-input field (whatever its Name) and a service of another type.
    ids.flagged = await serviceWith('imei', [
      ['model', 'Model', 0],
      ['serial', 'Serial', 1, true],
    ]);
    // A flagged field that is not named IMEI beside an unflagged field named IMEI: the flagged one stays the main input, nothing changes.
    ids.flaggedBesideImei = await serviceWith('imei', [
      ['serial', 'Serial', 0, true],
      ['imei', 'IMEI', 1],
    ]);
    ids.server = await serviceWith('server', [['account', 'Account', 0]]);
    ids.serverNamed = await serviceWith('server', [['imei', 'IMEI', 0]]);
    ids.serverBare = await serviceWith('server', []);
    untouchedBefore = await everyField([
      ids.flagged,
      ids.flaggedBesideImei,
      ids.server,
      ids.serverNamed,
      ids.serverBare,
    ]);

    // Only this migration: the next one (decision 073) makes the field it inserts of type imei.
    expect(await migrateUntil(url, IMEI_FIELD_TYPE_SUFFIX)).toBeGreaterThan(0);
  });

  it('gives a plain IMEI service the IMEI field first, its own fields moved down by one in their order', async () => {
    expect(await fieldsOf(ids.plain!)).toEqual([
      ['imei', 'IMEI', 0, true],
      ['model', 'Model', 1, false],
      ['note', 'Note', 2, false],
    ]);
    const { rows } = await pool.query(
      `select label, field_type, options, required, regex, supplier_key, is_main_input, sort
         from service_fields where service_id = $1 and key = 'imei'`,
      [ids.plain],
    );
    expect(rows).toEqual([
      {
        label: 'IMEI',
        field_type: 'text',
        options: [],
        required: true,
        regex: '',
        supplier_key: 'IMEI',
        is_main_input: true,
        sort: 0,
      },
    ]);
  });

  it('gives one to an IMEI service with no field at all, and to an archived one', async () => {
    expect(await fieldsOf(ids.bare!)).toEqual([['imei', 'IMEI', 0, true]]);
    expect(await fieldsOf(ids.archived!)).toEqual([
      ['imei', 'IMEI', 0, true],
      ['model', 'Model', 1, false],
    ]);
  });

  it('flags a field named IMEI in another letter case and inserts nothing', async () => {
    expect(await fieldsOf(ids.namedLower!)).toEqual([
      ['model', 'Model', 0, false],
      ['device', 'imei', 1, true],
    ]);
  });

  it('takes the first free key on a clash: imei_2, then imei_3', async () => {
    expect(await fieldsOf(ids.keyTaken!)).toEqual([
      ['imei_2', 'IMEI', 0, true],
      ['imei', 'IMEI:', 1, false],
    ]);
    expect(await fieldsOf(ids.twoKeysTaken!)).toEqual([
      ['imei_3', 'IMEI', 0, true],
      ['imei_2', 'Second', 1, false],
      ['imei', 'IMEI no.', 2, false],
    ]);
  });

  it('leaves a service that already has a main-input field and every service of another type exactly as they were', async () => {
    expect(
      await everyField([ids.flagged!, ids.flaggedBesideImei!, ids.server!, ids.serverNamed!, ids.serverBare!]),
    ).toEqual(untouchedBefore);
    expect(await fieldsOf(ids.flaggedBesideImei!)).toEqual([
      ['serial', 'Serial', 0, true],
      ['imei', 'IMEI', 1, false],
    ]);
  });

  it('changes nothing when its statements run again', async () => {
    const before = await everyField();
    for (const statement of migrationStatements(IMEI_MAIN_INPUT_SUFFIX)) await pool.query(statement);
    expect(await everyField()).toEqual(before);
  });
});

describe('an empty database', () => {
  it('runs with no service to change', async () => {
    const db = await scratch.create();
    expect(await migrateDatabase(db.url)).toBeGreaterThan(0);
  });
});
