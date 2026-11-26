// The field type imei (backend decision 073), migration `_imei_field_type.sql`, on a database held right before it and filled with the shapes
// stored fields have: the check of field_type takes imei only after it; a text field that is the main input of an IMEI service and is named
// IMEI in any letter case (archived services included) becomes of type imei with every other column kept; a main input with another Name or
// type, an unflagged field named IMEI and a field of a service of another type are not touched; running the statements again changes nothing,
// and the migration runs on an empty database.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import {
  IMEI_FIELD_TYPE_SUFFIX,
  ScratchDatabases,
  migrateUntil,
  migrationStatements,
  poolOn,
} from '../../support/migration-files';

setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('imeitype');
let url = '';
let pool: Pool;
const categoryOf: Record<string, number> = {};
let serviceCount = 0;

beforeAll(async () => {
  const db = await scratch.create();
  url = db.url;
  await migrateUntil(url, IMEI_FIELD_TYPE_SUFFIX);
  pool = poolOn(url);
  for (const type of ['imei', 'server']) {
    const { rows } = await pool.query<{ id: string }>(
      'insert into service_categories (name, type) values ($1, $2) returning id',
      [`IMEI type ${type}`, type],
    );
    categoryOf[type] = Number(rows[0]!.id);
  }
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await scratch.dropAll();
});

/** One stored field: its Name (also its label), type, main-input flag and pattern. */
interface StoredField {
  readonly name: string;
  readonly type?: string;
  readonly main?: boolean;
  readonly regex?: string;
}

/** Inserts a service of a type, optionally archived, with fields in form order; their keys are field_1, field_2, ... */
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
      `IMEI type ${serviceCount}`,
      `IT-${serviceCount}`,
      options.archived ? 'disabled' : 'active',
      options.archived ? new Date() : null,
    ],
  );
  const serviceId = Number(rows[0]!.id);
  for (const [index, field] of fields.entries()) {
    await pool.query(
      `insert into service_fields (service_id, key, label, supplier_key, field_type, sort, is_main_input, required, regex)
       values ($1, $2, $3, $3, $4, $5, $6, true, $7)`,
      [
        serviceId,
        `field_${index + 1}`,
        field.name,
        field.type ?? 'text',
        index,
        field.main ?? false,
        field.regex ?? '',
      ],
    );
  }
  return serviceId;
}

/** The message a refused statement fails with (`''` when it succeeded). */
async function failureOf(query: Promise<unknown>): Promise<string> {
  return query.then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

/** The type of every field of a service in form order. */
async function typesOf(serviceId: number): Promise<string[]> {
  const { rows } = await pool.query<{ field_type: string }>(
    'select field_type from service_fields where service_id = $1 order by sort, id',
    [serviceId],
  );
  return rows.map((row) => row.field_type);
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

describe('the stored fields', () => {
  const ids: Record<string, number> = {};
  let untouchedBefore: unknown[] = [];
  let convertedBefore: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    // The release before refuses the type.
    const probe = await serviceWith('server', []);
    expect(
      await failureOf(
        pool.query(
          `insert into service_fields (service_id, key, label, supplier_key, field_type) values ($1, 'probe', 'Probe', 'Probe', 'imei')`,
          [probe],
        ),
      ),
    ).toMatch(/service_fields_field_type_check/);

    // The 0071 shape: a required text main input named IMEI first, the supplier's fields after it.
    ids.imported = await serviceWith('imei', [{ name: 'IMEI', main: true }, { name: 'Model' }]);
    // A supplier field named IMEI in another letter case that the import flagged, with a pattern staff typed; and an archived service.
    ids.lowerCase = await serviceWith('imei', [{ name: 'Note' }, { name: 'imei', main: true, regex: '^35\\d{13}$' }]);
    ids.archived = await serviceWith('imei', [{ name: 'Imei', main: true }], { archived: true });
    // Not touched: a main input with another Name, a main input named IMEI of another type, an unflagged IMEI beside a flagged one,
    // and the fields of a service of another type.
    ids.ecid = await serviceWith('imei', [{ name: 'ECID', main: true }, { name: 'IMEI' }]);
    ids.number = await serviceWith('imei', [{ name: 'IMEI', type: 'number', main: true }]);
    ids.server = await serviceWith('server', [{ name: 'IMEI', main: true }, { name: 'Account' }]);
    untouchedBefore = await everyField([ids.ecid, ids.number, ids.server]);
    convertedBefore = (await everyField([ids.imported, ids.lowerCase, ids.archived])) as Array<Record<string, unknown>>;

    expect(await migrateDatabase(url)).toBeGreaterThan(0);
  });

  it('makes the main input of an IMEI service that is a text field named IMEI (any case, archived too) of type imei', async () => {
    expect(await typesOf(ids.imported!)).toEqual(['imei', 'text']);
    expect(await typesOf(ids.lowerCase!)).toEqual(['text', 'imei']);
    expect(await typesOf(ids.archived!)).toEqual(['imei']);
  });

  it('keeps every other column of a converted field', async () => {
    const after = (await everyField([ids.imported!, ids.lowerCase!, ids.archived!])) as Array<Record<string, unknown>>;
    const strip = ({ field_type: _type, updated_at: _at, ...rest }: Record<string, unknown>) => rest;
    expect(after.map(strip)).toEqual(convertedBefore.map(strip));
  });

  it('leaves another Name, another type, an unflagged IMEI field and a service of another type exactly as they were', async () => {
    expect(await everyField([ids.ecid!, ids.number!, ids.server!])).toEqual(untouchedBefore);
    expect(await typesOf(ids.ecid!)).toEqual(['text', 'text']);
  });

  it('accepts the type imei afterwards and still refuses an unknown one', async () => {
    const service = await serviceWith('server', []);
    await pool.query(
      `insert into service_fields (service_id, key, label, supplier_key, field_type) values ($1, 'device', 'Device', 'Device', 'imei')`,
      [service],
    );
    expect(
      await failureOf(
        pool.query(
          `insert into service_fields (service_id, key, label, supplier_key, field_type) values ($1, 'odd', 'Odd', 'Odd', 'email')`,
          [service],
        ),
      ),
    ).toMatch(/service_fields_field_type_check/);
  });

  it('changes nothing when its statements run again', async () => {
    const before = await everyField();
    for (const statement of migrationStatements(IMEI_FIELD_TYPE_SUFFIX)) await pool.query(statement);
    expect(await everyField()).toEqual(before);
  });
});

describe('an empty database', () => {
  it('runs with no field to change', async () => {
    const db = await scratch.create();
    expect(await migrateDatabase(db.url)).toBeGreaterThan(0);
  });
});
