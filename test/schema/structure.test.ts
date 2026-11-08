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

/**
 * Columns MISMATCHES B116 adds to the map's tables, and later additions: staff_users.totp_last_step (P2.6) and the
 * pre-Phase-3 audit resolutions (docs/contract/RESOLUTIONS.md, migration 0003), and the billing feature's invoices.checkout_url and
 * kyc_submissions.submitted_note (migration 0009).
 */
const ADDITIONS: Record<string, string[]> = {
  sessions: ['stage'],
  audit_logs: ['entity_label', 'actor_name'],
  services: ['code', 'sla_minutes', 'min_profit', 'cost_was', 'effective_cost', 'archived_at'],
  pricing_rules: ['starts_at', 'ends_at'],
  inventory_codes: ['code_hash', 'code_last4'],
  clients: [
    'suspended_at',
    'suspended_reason',
    'suspended_by',
    'twofa_enabled',
    'totp_last_step',
    'password_changed_at',
  ],
  staff_users: ['totp_last_step'],
  payments: [
    'reviewed_at',
    'review_note',
    'review_required',
    'auto_credit_at',
    'brand',
    'card_fingerprint',
    // Feature 16 (storefront payments, migrations 0011 and 0012): the checkout it pays, its Idempotency-Key, the hosted page, and the
    // fingerprint of the /pay request the key belongs to.
    'checkout_session_id',
    'idempotency_key',
    'checkout_url',
    'request_fingerprint',
  ],
  invoices: ['description', 'checkout_url'],
  kyc_submissions: ['submitted_note'],
  // Feature 16 (migration 0014): which idempotency key the next gateway send of the refund uses.
  refunds: ['note', 'send_attempt'],
  data_requests: ['note'],
  notifications: ['error', 'attempts', 'dedupe_key'],
  support_tickets: ['token', 'survey_sent_at'],
  webhook_deliveries: ['response_body', 'error', 'event_id'],
  alert_rules: ['deleted_at'],
  alert_events: [
    'rule_name',
    'metric',
    'comparator',
    'threshold',
    'window_seconds',
    'unit',
    'subject_label',
    'subject_key',
  ],
  commission_accruals: ['approved_at', 'reversed_at'],
  suppliers: ['api_key_hint', 'prices_synced_at'],
  supplier_api_logs: ['outcome'],
  imei_checks: ['country'],
  blocklist_entries: ['customer_id'],
};

interface Slice {
  ownedTables: Array<{ name: string; columns: string[] }>;
}
const slice = (module: string): Slice => JSON.parse(readFileSync(join(ROOT, `docs/slices/${module}.json`), 'utf8'));

describe('module ownership', () => {
  it('each module schema exports exactly the tables the map assigns to it', async () => {
    const path = '../../scripts/module-map.mjs';
    const { modules } = (await import(path)) as {
      modules: Array<{ id: string; tables: string[]; additionalTables?: string[] }>;
    };
    expect(modules).toHaveLength(12);
    for (const module of modules) {
      const owned = tablesOf(moduleSchemas[module.id]!).map(nameOf);
      expect(owned.sort(), module.id).toEqual([...module.tables, ...(module.additionalTables ?? [])].sort());
    }
  });

  it("the infra barrel re-exports all 69 tables once (the map's 66 and the backend's listed_prices, idempotency_keys and alert_streaks)", () => {
    const names = tablesOf(barrel).map(nameOf);
    expect(names).toHaveLength(69);
    expect(new Set(names).size).toBe(69);
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

describe('audit resolutions (docs/contract/RESOLUTIONS.md, migration 0003)', () => {
  const all = tablesOf(barrel);
  const tableConfig = (name: string) => getTableConfig(all.find((table) => nameOf(table) === name)!);
  const columnOf = (table: string, name: string) =>
    tableConfig(table).columns.find((column) => casing.getColumnCasing(column) === name)!;
  const checkNames = (table: string) => tableConfig(table).checks.map((check) => check.name);
  const indexOf = (table: string, name: string) =>
    tableConfig(table).indexes.find((index) => index.config.name === name);

  it('makes these columns required (the wire never carries null for them)', () => {
    const required: Array<[string, string[]]> = [
      ['audit_logs', ['actor_name']],
      ['ledger_transactions', ['ref_id']],
      ['invoices', ['net_amount', 'tax_amount', 'tax_rate', 'tax_country', 'customer_vat_id']],
      ['services', ['base_price', 'effective_cost', 'price_mode', 'duplicate_rule']],
      ['inventory_codes', ['batch_ref']],
      ['supplier_api_logs', ['http_status', 'duration_ms', 'error', 'outcome']],
      ['alert_events', ['rule_name', 'metric', 'comparator', 'threshold', 'window_seconds', 'subject_type']],
      ['job_runs', ['duration_ms', 'processed']],
      ['commission_accruals', ['order_id']],
      ['consent_records', ['ip']],
      ['payments', ['brand', 'review_required']],
    ];
    for (const [table, columns] of required) {
      for (const name of columns) expect(columnOf(table, name).notNull, `${table}.${name}`).toBe(true);
    }
  });

  it('makes these columns optional on purpose', () => {
    const optional: Array<[string, string[]]> = [
      ['service_checks', ['detail']],
      ['imei_checks', ['imei_hash', 'imei_enc', 'country']],
      ['alert_events', ['unit']],
      ['suppliers', ['api_key_hint', 'prices_synced_at']],
      ['services', ['archived_at']],
      ['payments', ['auto_credit_at', 'card_fingerprint']],
      ['commission_accruals', ['approved_at']],
      ['blocklist_entries', ['customer_id']],
    ];
    for (const [table, columns] of optional) {
      for (const name of columns) expect(columnOf(table, name).notNull, `${table}.${name}`).toBe(false);
    }
  });

  it('sets the defaults the writers rely on', () => {
    const defaults: Array<[string, string, unknown]> = [
      ['audit_logs', 'actor_name', ''],
      ['ledger_transactions', 'ref_id', 0],
      ['invoices', 'tax_amount', '0'],
      ['invoices', 'tax_rate', '0'],
      ['invoices', 'tax_country', ''],
      ['invoices', 'customer_vat_id', ''],
      ['services', 'price_mode', 'fixed'],
      ['services', 'duplicate_rule', 'block_open'],
      ['services', 'effective_cost', '0'],
      ['suppliers', 'low_balance_alert', '150'],
      ['suppliers', 'max_concurrency', 5],
      ['suppliers', 'rate_limit_per_min', 60],
      ['suppliers', 'timeout_ms', 15000],
      ['supplier_api_logs', 'http_status', 0],
      ['supplier_api_logs', 'duration_ms', 0],
      ['supplier_api_logs', 'error', ''],
      ['supplier_api_logs', 'outcome', 'ok'],
      ['alert_events', 'subject_type', 'system'],
      ['job_runs', 'duration_ms', 0],
      ['job_runs', 'processed', 0],
      ['checkout_sessions', 'status', 'open'],
      ['payments', 'brand', ''],
      ['payments', 'review_required', false],
    ];
    for (const [table, name, value] of defaults) {
      expect(columnOf(table, name).default, `${table}.${name}`).toEqual(value);
    }
    // The paramFormat of a supplier has no default on purpose: the writer derives it from the driver.
    expect(columnOf('suppliers', 'param_format').hasDefault).toBe(false);
    expect(columnOf('commission_plans', 'tiers').getSQLType()).toBe('jsonb');
    expect(columnOf('commission_plans', 'tiers').default).toEqual({});
    expect(columnOf('service_checks', 'detail').getSQLType()).toBe('text');
  });

  it('closes each open vocabulary with a named CHECK', () => {
    const expected: Array<[string, string[]]> = [
      ['auth_tokens', ['auth_tokens_purpose_check']],
      ['audit_logs', ['audit_logs_actor_type_check']],
      ['notifications', ['notifications_recipient_type_check']],
      ['payments', ['payments_status_check', 'payments_method_type_check']],
      ['refunds', ['refunds_method_check', 'refunds_storefront_refs_check']],
      ['ledger_transactions', ['ledger_transactions_ref_type_check', 'ledger_transactions_ref_id_check']],
      ['services', ['services_price_mode_check', 'services_duplicate_rule_check', 'services_effective_cost_check']],
      ['services', ['services_archived_check', 'services_prices_check']],
      ['orders', ['orders_verification_status_check']],
      ['order_events', ['order_events_type_check']],
      ['suppliers', ['suppliers_driver_check', 'suppliers_param_format_check', 'suppliers_limits_check']],
      ['supplier_api_logs', ['supplier_api_logs_numbers_check', 'supplier_api_logs_outcome_check']],
      ['alert_events', ['alert_events_comparator_check', 'alert_events_unit_check', 'alert_events_subject_type_check']],
      ['commission_accruals', ['commission_accruals_status_check', 'commission_accruals_approved_at_check']],
      ['commission_plans', ['commission_plans_tiers_check']],
      ['checkout_sessions', ['checkout_sessions_status_check']],
      ['consent_records', ['consent_records_purpose_check', 'consent_records_subject_type_check']],
      ['legal_documents', ['legal_documents_type_check']],
      ['imei_checks', ['imei_checks_country_check', 'imei_checks_imei_erased_check']],
      ['service_checks', ['service_checks_supplier_key_check', 'service_checks_gateway_key_check']],
      ['job_runs', ['job_runs_counts_check']],
      ['inventory_codes', ['inventory_codes_batch_ref_check']],
      ['client_groups', ['client_groups_amounts_check']],
    ];
    for (const [table, names] of expected) {
      for (const name of names) expect(checkNames(table), `${table} lacks ${name}`).toContain(name);
    }
  });

  it('drops the values the resolutions removed, and keeps the lists closed', () => {
    expect(money.LEDGER_REF_TYPES).not.toContain('ledger_transaction');
    expect(support.TICKET_STATUSES).not.toContain('closed');
    expect(money.TOPUP_PAYMENT_STATUSES).toEqual(['pending', 'approved', 'rejected']);
    expect(money.TOPUP_METHODS).toEqual(['bank', 'card', 'usdt', 'wise']);
    expect(money.ORDER_METHODS).toEqual(['card', 'wallet', 'crypto']);
    expect(catalog.SERVICE_PRICE_MODES).toEqual(['fixed']);
    expect(identity.AUTH_TOKEN_PURPOSES).toEqual(['invite', 'reset', 'verify_email', 'magic_link', 'telegram_link']);
    // Every order event type the engine writes is in the list (a new one needs a migration).
    expect(orders.ORDER_EVENT_TYPES).toHaveLength(21);
  });

  it('keeps a service in the type of its category with a composite foreign key', () => {
    const composite = tableConfig('services').foreignKeys.find((key) => key.getName() === 'services_category_type_fk');
    expect(composite, 'services_category_type_fk').toBeDefined();
    const reference = composite!.reference();
    expect(reference.columns.map((column) => casing.getColumnCasing(column))).toEqual(['category_id', 'type']);
    expect(reference.foreignColumns.map((column) => casing.getColumnCasing(column))).toEqual(['id', 'type']);
    expect(composite!.onUpdate).toBe('cascade');
    expect(composite!.onDelete).toBe('restrict');
    // The single-column foreign key is replaced, not doubled.
    const onCategory = tableConfig('services').foreignKeys.filter(
      (key) => casing.getColumnCasing(key.reference().columns[0]!) === 'category_id',
    );
    expect(onCategory).toHaveLength(1);
    const target = tableConfig('service_categories').uniqueConstraints.map((unique) => unique.name);
    expect(target).toContain('service_categories_id_type_uq');
    // The database check of the foreign key index wants a full index that starts with both columns.
    const serving = indexOf('services', 'services_category_type_idx');
    expect(serving?.config.columns.map((column) => toSnakeCase((column as { name: string }).name))).toEqual([
      'category_id',
      'type',
    ]);
    expect(indexOf('services', 'services_category_id_idx')).toBeUndefined();
  });

  it('adds the unique and partial indexes of the resolutions', () => {
    const unique: Array<[string, string, boolean]> = [
      ['services', 'services_code_uq', true],
      ['commission_assignments', 'commission_assignments_current_uq', true],
      ['commission_accruals', 'commission_accruals_order_beneficiary_uq', true],
      ['incidents', 'incidents_alert_event_uq', true],
      ['services', 'services_live_type_status_idx', false],
      ['services', 'services_effective_cost_idx', false],
      ['payments', 'payments_auto_credit_idx', false],
      ['payments', 'payments_card_fingerprint_idx', false],
      ['blocklist_entries', 'blocklist_entries_customer_id_idx', false],
    ];
    for (const [table, name, isUnique] of unique) {
      const index = indexOf(table, name);
      expect(index, `${table}.${name}`).toBeDefined();
      expect(index!.config.unique, `${table}.${name} unique`).toBe(isUnique);
    }
    // The old per-plan and per-event indexes are gone.
    expect(indexOf('commission_assignments', 'commission_assignments_active_uq')).toBeUndefined();
    expect(indexOf('incidents', 'incidents_alert_event_id_idx')).toBeUndefined();
    // A full order_id index stays beside the partial unique one: only a full index serves the foreign key.
    expect(indexOf('commission_accruals', 'commission_accruals_order_id_idx')).toBeDefined();
  });

  it('numbers inventory batches from one sequence', () => {
    expect(catalog.inventoryBatchRefSeq.seqName).toBe('inventory_batch_ref_seq');
  });
});
