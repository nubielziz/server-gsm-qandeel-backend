// Structure of the Drizzle schema (decision 027), checked without a database: module ownership, the map's columns,
// primary keys and timestamps, an index behind every foreign key, one CHECK per enumeration, no float columns.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQL, is } from 'drizzle-orm';
import { CasingCache, toSnakeCase } from 'drizzle-orm/casing';
import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as commissions from '../../src/modules/commissions/db/schema';
import * as catalog from '../../src/modules/catalog/db/schema';
import * as customers from '../../src/modules/customers/db/schema';
import * as health from '../../src/modules/health/db/schema';
import * as identity from '../../src/modules/identity/db/schema';
import * as money from '../../src/modules/money/db/schema';
import * as orders from '../../src/modules/orders/db/schema';
import * as platform from '../../src/modules/platform/db/schema';
import * as risk from '../../src/modules/risk/db/schema';
import * as storefront from '../../src/modules/storefront/db/schema';
import * as suppliers from '../../src/modules/suppliers/db/schema';
import * as support from '../../src/modules/support/db/schema';
import * as barrel from '../../src/infra/db/schema';

const ROOT = join(import.meta.dir, '../..');
const casing = new CasingCache('snake_case');
const dialect = new PgDialect({ casing: 'snake_case' });

const moduleSchemas: Record<string, Record<string, unknown>> = {
  identity,
  platform,
  money,
  catalog,
  orders,
  suppliers,
  health,
  commissions,
  customers,
  storefront,
  support,
  risk,
};

const tablesOf = (exports: Record<string, unknown>): PgTable[] =>
  Object.values(exports).filter((value): value is PgTable => is(value, PgTable));

const nameOf = (table: PgTable) => getTableConfig(table).name;

/** The SQL column an index starts with; undefined for an expression such as lower(email). */
function leadingColumn(index: { config: { columns: unknown[] } }): string | undefined {
  const first = index.config.columns[0];
  if (!first || is(first, SQL)) return undefined;
  const column = first as { name: string; table?: unknown };
  // A plain column knows its table (casing needs it); an ordered one (`.desc()`) only carries its key.
  return column.table ? casing.getColumnCasing(first as never) : toSnakeCase(column.name);
}

/** Tables with no `updated_at`: the four append-only tables and the four immutable logs (see each table's TSDoc). */
const IMMUTABLE = new Set([
  'ledger_entries',
  'ledger_transactions',
  'order_events',
  'audit_logs',
  'supplier_api_logs',
  'service_checks',
  'consent_records',
  'ticket_messages',
]);

/** Columns MISMATCHES B116 adds to the map's tables, and later features' additions (staff_users.totp_last_step: P2.6). */
const ADDITIONS: Record<string, string[]> = {
  sessions: ['stage'],
  audit_logs: ['entity_label'],
  services: ['code', 'sla_minutes', 'min_profit', 'cost_was'],
  pricing_rules: ['starts_at', 'ends_at'],
  inventory_codes: ['code_hash', 'code_last4'],
  clients: ['suspended_at', 'suspended_reason', 'suspended_by'],
  staff_users: ['totp_last_step'],
  payments: ['reviewed_at', 'review_note'],
  invoices: ['description'],
  refunds: ['note'],
  data_requests: ['note'],
  notifications: ['error'],
  webhook_deliveries: ['response_body', 'error'],
  alert_rules: ['deleted_at'],
};

interface Slice {
  ownedTables: Array<{ name: string; columns: string[] }>;
}
const slice = (module: string): Slice => JSON.parse(readFileSync(join(ROOT, `docs/slices/${module}.json`), 'utf8'));

describe('module ownership', () => {
  it('each module schema exports exactly the tables the map assigns to it', async () => {
    const path = '../../scripts/module-map.mjs';
    const { modules } = (await import(path)) as { modules: Array<{ id: string; tables: string[] }> };
    expect(modules).toHaveLength(12);
    for (const module of modules) {
      const owned = tablesOf(moduleSchemas[module.id]!).map(nameOf);
      expect(owned.sort(), module.id).toEqual([...module.tables].sort());
    }
  });

  it('the infra barrel re-exports all 66 tables once', () => {
    const names = tablesOf(barrel).map(nameOf);
    expect(names).toHaveLength(66);
    expect(new Set(names).size).toBe(66);
  });
});

describe('columns', () => {
  const all = tablesOf(barrel);

  it('contain every column of the map plus the id, timestamps and the B116 additions, and nothing else', () => {
    for (const module of Object.keys(moduleSchemas)) {
      for (const owned of slice(module).ownedTables) {
        const table = all.find((candidate) => nameOf(candidate) === owned.name)!;
        const actual = getTableConfig(table).columns.map((column) => casing.getColumnCasing(column));
        const fromMap = owned.columns.map((column) => column.split(' ')[0]!);
        const timestamps = IMMUTABLE.has(owned.name) ? ['created_at'] : ['created_at', 'updated_at'];
        const expected = new Set(['id', ...fromMap, ...timestamps, ...(ADDITIONS[owned.name] ?? [])]);
        expect([...new Set(actual)].sort(), owned.name).toEqual([...expected].sort());
      }
    }
  });

  it('give every table an identity primary key, created_at, and updated_at unless it is immutable', () => {
    for (const table of all) {
      const config = getTableConfig(table);
      const byName = new Map(config.columns.map((column) => [casing.getColumnCasing(column), column]));
      const id = byName.get('id')!;
      expect(id.primary, config.name).toBe(true);
      expect(id.getSQLType(), config.name).toBe('bigint');
      expect(
        id.generated?.type ?? (id as { generatedIdentity?: { type: string } }).generatedIdentity?.type,
        config.name,
      ).toBe('always');
      expect(byName.has('created_at'), config.name).toBe(true);
      expect(byName.has('updated_at'), config.name).toBe(!IMMUTABLE.has(config.name));
    }
  });

  it('never use a floating point type, and keep numerics to money, rate and percent precision', () => {
    for (const table of all) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const type = column.getSQLType();
        expect(['real', 'double precision', 'float4', 'float8'], `${config.name}.${column.name}`).not.toContain(type);
        if (type.startsWith('numeric')) {
          expect(['numeric(18, 4)', 'numeric(18, 8)', 'numeric(9, 4)'], `${config.name}.${column.name}`).toContain(
            type,
          );
        }
      }
    }
  });
});

describe('indexes', () => {
  it('put an index (or unique constraint) behind every foreign key, starting with the foreign key column', () => {
    const missing: string[] = [];
    for (const table of tablesOf(barrel)) {
      const config = getTableConfig(table);
      const leading = new Set<string>();
      for (const index of config.indexes) {
        // A partial index cannot serve the foreign key's restrict and cascade checks.
        const first = index.config.where ? undefined : leadingColumn(index);
        if (first) leading.add(first);
      }
      for (const unique of config.uniqueConstraints) leading.add(casing.getColumnCasing(unique.columns[0]!));
      for (const foreignKey of config.foreignKeys) {
        const column = foreignKey.reference().columns[0]!;
        if (!leading.has(casing.getColumnCasing(column))) missing.push(`${config.name}.${column.name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('enumerations', () => {
  it('every exported enumeration array is the value list of at least one CHECK constraint, and each CHECK list is one', () => {
    const arrays = new Map<string, string[]>();
    for (const [name, value] of Object.entries(barrel)) {
      if (/^[A-Z][A-Z0-9_]+$/.test(name) && Array.isArray(value)) arrays.set(name, value as string[]);
    }
    expect(arrays.size).toBeGreaterThan(60);
    const rendered = tablesOf(barrel).flatMap((table) =>
      getTableConfig(table).checks.map((check) => dialect.sqlToQuery(check.value).sql),
    );
    const list = (values: string[]) => `in (${values.map((value) => `'${value}'`).join(', ')})`;
    for (const [name, values] of arrays) {
      expect(
        rendered.some((sqlText) => sqlText.includes(list(values))),
        `${name} is not used in any CHECK constraint`,
      ).toBe(true);
    }
  });
});
