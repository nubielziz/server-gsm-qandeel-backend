// Structure of the Drizzle schema (decision 027), checked without a database: module ownership, the map's columns,
// primary keys and timestamps, an index behind every foreign key, one CHECK per enumeration, no float columns.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQL, is } from 'drizzle-orm';
import { CasingCache, toSnakeCase } from 'drizzle-orm/casing';
import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as commissions from '@src/modules/commissions/db/schema';
import * as catalog from '@src/modules/catalog/db/schema';
import * as customers from '@src/modules/customers/db/schema';
import * as health from '@src/modules/health/db/schema';
import * as identity from '@src/modules/identity/db/schema';
import * as money from '@src/modules/money/db/schema';
import * as orders from '@src/modules/orders/db/schema';
import * as platform from '@src/modules/platform/db/schema';
import * as risk from '@src/modules/risk/db/schema';
import * as storefront from '@src/modules/storefront/db/schema';
import * as suppliers from '@src/modules/suppliers/db/schema';
import * as support from '@src/modules/support/db/schema';
import * as barrel from '@src/infra/db/schema';

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
  // The raised part of a credit limit, per staff member, merchant and time: written once, summed over 24 hours.
  'credit_limit_raises',
  // Decision 064: the map of old merchant and customer numbers to accounts, the history of rank changes, and the keys of the staff
  // freeze, unfreeze and credit-limit changes: each written once, none updated (append-only triggers and grants).
  'account_legacy_ids',
  'account_rank_changes',
  'wallet_action_keys',
]);

/**
 * Columns MISMATCHES B116 adds to the map's tables, and later additions: staff_users.totp_last_step (P2.6) and the
 * pre-Phase-3 audit resolutions (docs/contract/RESOLUTIONS.md, migration 0003), and the billing feature's invoices.checkout_url and
 * kyc_submissions.submitted_note (migration 0009), and services.sort, the stored order of services (decision 063, migration 0063), and
 * the columns of the one account type (decision 064): the five new columns of `clients` and the `account_id` buyer column of every table
 * that named a customer (the old columns keep their SQL names and stay in the map's lists until the contract release drops them), and
 * service_fields.is_main_input, the flag of a service's main input (decision 065, migration 0068).
 */
const ADDITIONS: Record<string, string[]> = {
  sessions: ['stage'],
  audit_logs: ['entity_label', 'actor_name'],
  services: ['code', 'sla_minutes', 'min_profit', 'cost_was', 'effective_cost', 'archived_at', 'sort'],
  pricing_rules: ['starts_at', 'ends_at'],
  inventory_codes: ['code_hash', 'code_last4'],
  clients: [
    'suspended_at',
    'suspended_reason',
    'suspended_by',
    'twofa_enabled',
    'totp_last_step',
    'password_changed_at',
    // Feature 20 (merchant management, migration 0020).
    'must_change_password',
    'last_login_at',
    'last_login_ip',
    'address',
    'tax_id',
    'internal_notes',
    // The count of wrong authenticator codes of the code step (its 24 hours, the cap and the recorded closing).
    'totp_failures',
    'totp_failures_since',
    'totp_locked_at',
    // Set with a temporary password by staff, cleared by a password from a mailed link.
    'password_set_by_staff',
    // Set by a staff change of the email address.
    'email_set_by_staff',
    // Decision 064: a guest is a row without a login; the shop currency; the marketing choice; the erasure time; who created the row.
    'has_account',
    'currency',
    'marketing_opt_in',
    'anonymized_at',
    'created_by',
  ],
  api_keys: ['created_by'],
  // The keyed hash of the cookie of the browser that asked for a storefront sign-in link.
  auth_tokens: ['browser_hash'],
  staff_users: ['totp_last_step', 'totp_failures', 'totp_failures_since', 'totp_locked_at'],
  payments: [
    'account_id',
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
  // Feature 21 (customer wallet, migration 0020): the store top-up's Idempotency-Key and request fingerprint. Decision 049: who issued a
  // manual invoice.
  // Decision 064: the account the invoice is for and the wallet kind a top-up or manual invoice credits.
  invoices: [
    'description',
    'checkout_url',
    'idempotency_key',
    'request_fingerprint',
    'issued_by',
    'account_id',
    'wallet_kind',
  ],
  // Decision 049: when a refresh held the provider's rate.
  currencies: ['rate_held_at'],
  // Feature 21: the freeze state of a customer wallet; whether a checkout was opened by a signed-in customer.
  ledger_accounts: ['frozen_at', 'frozen_reason'],
  // Feature 44 (decision 054): the keyed hash and the encrypted copy of the link token. Feature 40 (decision 050): the visitor's country.
  checkout_sessions: ['opened_signed_in', 'token_hash', 'token_enc', 'ip_country', 'account_id'],
  orders: ['public_token_hash', 'public_token_enc', 'account_id'],
  kyc_submissions: ['submitted_note'],
  // Feature 16 (migration 0014): which idempotency key the next gateway send of the refund uses; and when a send ended without a
  // definite answer (migration 0058).
  refunds: ['note', 'send_attempt', 'unanswered_send_at', 'account_id'],
  data_requests: ['note', 'account_id'],
  // Decision 064: the buyer account of a dispute and of a risk assessment.
  disputes: ['account_id'],
  risk_assessments: ['account_id'],
  notifications: ['error', 'attempts', 'dedupe_key', 'campaign_id'],
  // Feature 28 (migration 0031): the seen marks of both sides, the newest message of each side and the reply-mail sweep's columns.
  support_tickets: [
    'token',
    'survey_sent_at',
    'requester_seen_message_id',
    'requester_seen_at',
    'staff_seen_message_id',
    'staff_seen_at',
    'last_requester_message_id',
    'last_staff_message_id',
    'reply_mail_due_at',
    'reply_mailed_message_id',
    // Feature 44 (decision 054): the keyed hash and the encrypted copy of the link token.
    'token_hash',
    'token_enc',
    // Feature 43 (decision 053): when the requester's address was proven.
    'requester_proven_at',
  ],
  // Feature 28: the channel a public staff message was delivered on.
  ticket_messages: ['notify_channel'],
  webhook_deliveries: ['response_body', 'error', 'event_id'],
  // Feature 43 (decision 053): deliveries in a row that ended failed; 20 switch the endpoint off.
  webhook_endpoints: ['consecutive_failed_deliveries'],
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
  // Feature 40 (decision 050): an entry limited to guest checkouts.
  blocklist_entries: ['customer_id', 'guest_only', 'account_id'],
  // Feature 22 (storefront catalog): first publication, 30-day sales for the popularity sort, the service picture.
  service_listings: ['listed_at', 'sales_30d', 'image_file_id'],
  // Feature 32 (migration 0040): the ready-made method a payment method was made from, and the logo staff uploaded for it.
  payment_gateways: ['preset', 'logo_file_id'],
  // Feature 31 (migration 0045): the quick add run that created the service this link belongs to.
  service_supplier_links: ['import_run_id'],
  // Decision 065 (migration 0068): the field whose value travels as the IMEI parameter.
  service_fields: ['is_main_input'],
};

/**
 * Map columns the backend dropped by decision 039 (English only, B224): the language of a row. Each entry is added by the slice of
 * feature 30 that drops the column; `legal_documents.locale` stays (the archive tag of a retired version).
 */
const REMOVED: Record<string, string[]> = {
  service_listings: ['locale'],
  content_pages: ['locale'],
  help_articles: ['locale'],
  notification_templates: ['locale'],
  reply_templates: ['locale'],
  customers: ['locale'],
};

interface Slice {
  /** `retired: true` marks a table of the module's `retiredTables` (scripts/build-route-slices.mjs): its columns are not checked. */
  ownedTables: Array<{ name: string; columns: string[]; retired?: boolean }>;
}

interface ModuleEntry {
  id: string;
  tables: string[];
  additionalTables?: string[];
  retiredTables?: string[];
}

/** The module map and the live tables it implies (the retired ones left out), loaded at run time because both are plain JavaScript. */
async function moduleMap(): Promise<{ modules: ModuleEntry[]; live: string[] }> {
  const modulesPath = '../../scripts/module-map.mjs';
  const mapPath = '../../scripts/lib/map.mjs';
  const { modules } = (await import(modulesPath)) as { modules: ModuleEntry[] };
  const { liveTablesOf } = (await import(mapPath)) as { liveTablesOf(list: ModuleEntry[]): string[] };
  return { modules, live: liveTablesOf(modules) };
}
const slice = (module: string): Slice => JSON.parse(readFileSync(join(ROOT, `docs/slices/${module}.json`), 'utf8'));

describe('module ownership', () => {
  it('each module schema exports exactly the live tables the map assigns to it (a retired table is owned but not exported)', async () => {
    const { modules } = await moduleMap();
    // A module of the map without its schema import above (or the reverse) fails here by name.
    expect(modules.map((module) => module.id).sort()).toEqual(Object.keys(moduleSchemas).sort());
    for (const module of modules) {
      const owned = tablesOf(moduleSchemas[module.id]!).map(nameOf);
      const retired = new Set(module.retiredTables ?? []);
      const expected = [...module.tables, ...(module.additionalTables ?? [])].filter((name) => !retired.has(name));
      expect(owned.sort(), module.id).toEqual(expected.sort());
    }
  });

  it("the infra barrel re-exports every live table of the module map once (the map's tables and each module's additionalTables)", async () => {
    const { live } = await moduleMap();
    const names = tablesOf(barrel).map(nameOf);
    expect(new Set(names).size, 'the barrel exports a table twice').toBe(names.length);
    expect([...names].sort()).toEqual(live);
  });

  it('the slices mark exactly the retired tables of the module map', async () => {
    const { modules } = await moduleMap();
    for (const module of modules) {
      const marked = slice(module.id)
        .ownedTables.filter((owned) => owned.retired === true)
        .map((owned) => owned.name);
      expect(marked.sort(), module.id).toEqual([...(module.retiredTables ?? [])].sort());
    }
  });
});

describe('columns', () => {
  const all = tablesOf(barrel);

  it('contain every column of the map plus the id, timestamps and the B116 additions, and nothing else', () => {
    for (const module of Object.keys(moduleSchemas)) {
      for (const owned of slice(module).ownedTables) {
        // A retired table is a map table the contract release dropped: it has no Drizzle table and no columns to compare.
        if (owned.retired === true) continue;
        const table = all.find((candidate) => nameOf(candidate) === owned.name)!;
        const actual = getTableConfig(table).columns.map((column) => casing.getColumnCasing(column));
        const fromMap = owned.columns.map((column) => column.split(' ')[0]!);
        const timestamps = IMMUTABLE.has(owned.name) ? ['created_at'] : ['created_at', 'updated_at'];
        const expected = new Set(['id', ...fromMap, ...timestamps, ...(ADDITIONS[owned.name] ?? [])]);
        for (const removed of REMOVED[owned.name] ?? []) expected.delete(removed);
        expect([...new Set(actual)].sort(), owned.name).toEqual([...expected].sort());
      }
    }
  });

  it('drop only map columns (REMOVED names a column the map gives that table), and keep legal_documents.locale', () => {
    const mapColumns = new Map(
      Object.keys(moduleSchemas).flatMap((module) =>
        slice(module).ownedTables.map(
          (owned) => [owned.name, owned.columns.map((column) => column.split(' ')[0]!)] as const,
        ),
      ),
    );
    for (const [table, columns] of Object.entries(REMOVED)) {
      for (const column of columns) expect(mapColumns.get(table) ?? [], `${table}.${column}`).toContain(column);
    }
    const legal = all.find((candidate) => nameOf(candidate) === 'legal_documents')!;
    expect(getTableConfig(legal).columns.map((column) => casing.getColumnCasing(column))).toContain('locale');
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
      ['invoices', ['net_amount', 'tax_amount', 'tax_rate', 'tax_country', 'customer_vat_id', 'account_id']],
      ['services', ['base_price', 'effective_cost', 'price_mode', 'duplicate_rule']],
      ['inventory_codes', ['batch_ref']],
      ['supplier_api_logs', ['http_status', 'duration_ms', 'error', 'outcome']],
      ['alert_events', ['rule_name', 'metric', 'comparator', 'threshold', 'window_seconds', 'subject_type']],
      ['job_runs', ['duration_ms', 'processed']],
      ['commission_accruals', ['order_id']],
      ['consent_records', ['ip']],
      ['payments', ['brand', 'review_required', 'account_id']],
      // Decision 064: every order, dispute and data request has a buyer account, and every account says whether it has a login.
      ['orders', ['account_id']],
      ['disputes', ['account_id']],
      ['data_requests', ['account_id']],
      ['clients', ['has_account', 'marketing_opt_in']],
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
      ['blocklist_entries', ['customer_id', 'account_id']],
      ['checkout_sessions', ['ip_country', 'account_id']],
      // Decision 064: not every row has these (a refund without a payment, an invoice that is no top-up or manual one, a checkout
      // made signed out); a guest has no username; the old customer column of a data request is no longer filled.
      ['refunds', ['account_id']],
      ['risk_assessments', ['account_id']],
      ['invoices', ['wallet_kind']],
      ['clients', ['username', 'currency', 'anonymized_at', 'created_by']],
      ['data_requests', ['customer_id']],
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
      ['blocklist_entries', 'guest_only', false],
      ['clients', 'has_account', true],
      ['clients', 'marketing_opt_in', false],
      ['clients', 'status', 'active'],
      ['account_legacy_ids', 'merged', false],
      ['account_rank_changes', 'moved_amount', '0'],
      ['account_rank_changes', 'sessions_ended', 0],
      ['account_rank_changes', 'api_keys_revoked', 0],
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
      ['refunds', ['refunds_method_check', 'refunds_account_refs_check']],
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
      ['checkout_sessions', ['checkout_sessions_status_check', 'checkout_sessions_ip_country_check']],
      ['consent_records', ['consent_records_purpose_check', 'consent_records_subject_type_check']],
      ['legal_documents', ['legal_documents_type_check']],
      ['imei_checks', ['imei_checks_country_check', 'imei_checks_imei_erased_check']],
      ['service_checks', ['service_checks_supplier_key_check', 'service_checks_gateway_key_check']],
      ['job_runs', ['job_runs_counts_check']],
      ['inventory_codes', ['inventory_codes_batch_ref_check']],
      [
        'client_groups',
        ['client_groups_amounts_check', 'client_groups_kind_check', 'client_groups_retail_no_credit_check'],
      ],
      // Decision 064: the accounts table and the one stored type word.
      ['clients', ['clients_status_check', 'clients_guest_check', 'clients_anonymized_check']],
      ['files', ['files_owner_type_check']],
      ['ledger_accounts', ['ledger_accounts_owner_type_check']],
      ['orders', ['orders_hold_buyer_check', 'orders_door_check']],
      ['invoices', ['invoices_wallet_kind_check', 'invoices_client_account_check']],
      ['audit_logs', ['audit_logs_actor_type_check', 'audit_logs_actor_type_current_check']],
      ['order_events', ['order_events_actor_type_check', 'order_events_actor_type_current_check']],
      [
        'ledger_transactions',
        ['ledger_transactions_created_by_type_current_check', 'ledger_transactions_ref_type_current_check'],
      ],
      [
        'account_legacy_ids',
        ['account_legacy_ids_type_check', 'account_legacy_ids_client_check', 'account_legacy_ids_merged_check'],
      ],
      [
        'account_rank_changes',
        [
          'account_rank_changes_kind_check',
          'account_rank_changes_groups_check',
          'account_rank_changes_amount_check',
          'account_rank_changes_transaction_check',
        ],
      ],
      ['wallet_action_keys', ['wallet_action_keys_action_check']],
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
    expect(money.ORDER_METHODS).toEqual(['card', 'wallet', 'crypto', 'balance']);
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

describe('one account type (decision 064)', () => {
  const all = tablesOf(barrel);
  /** What the expand release of decision 064 adds to the schema, read by name: a symbol that is missing fails its own case instead of the whole file. */
  const symbols = barrel as unknown as Record<string, unknown>;
  const sorted = (values: unknown): string[] => [...(values as readonly string[])].sort();
  const tableOf = (name: string) => all.find((table) => nameOf(table) === name)!;
  const tableConfig = (name: string) => getTableConfig(tableOf(name));
  const indexNamed = (table: string, name: string) => {
    const config = tableConfig(table);
    return (
      config.indexes.find((index) => index.config.name === name) ??
      config.uniqueConstraints.find((unique) => unique.name === name)
    );
  };
  const isUnique = (table: string, name: string): boolean => {
    const found = indexNamed(table, name) as { config?: { unique?: boolean } } | undefined;
    return found === undefined ? false : found.config === undefined || found.config.unique === true;
  };

  it('narrows the mutable vocabularies to the one word account', () => {
    expect(sorted(symbols.SUBJECT_TYPES)).toEqual(sorted(['staff', 'account']));
    expect(sorted(symbols.LEDGER_OWNER_TYPES)).toEqual(sorted(['account', 'supplier']));
    expect(sorted(symbols.NOTIFICATION_RECIPIENT_TYPES)).toEqual(sorted(['staff', 'account']));
    expect(sorted(symbols.TICKET_REQUESTER_TYPES)).toEqual(['account']);
    expect(sorted(symbols.TICKET_AUTHOR_TYPES)).toEqual(sorted(['staff', 'account', 'system']));
    expect(sorted(symbols.CONSENT_SUBJECT_TYPES)).toEqual(['account']);
    expect(sorted(symbols.FILE_OWNER_TYPES)).toEqual(sorted(['staff', 'account']));
    expect(sorted(symbols.REFUND_REQUESTER_TYPES)).toEqual(sorted(['staff', 'account', 'system']));
    expect(sorted(symbols.ALERT_SUBJECT_TYPES)).toEqual(
      sorted(['system', 'supplier', 'queue', 'gateway', 'ledger_account', 'account']),
    );
  });

  it('widens the append-only vocabularies by account and keeps the words of today in a CURRENT_* list', () => {
    expect(sorted(symbols.AUDIT_ACTOR_TYPES)).toEqual(sorted(['staff', 'client', 'customer', 'system', 'account']));
    expect(sorted(symbols.CURRENT_AUDIT_ACTOR_TYPES)).toEqual(sorted(['staff', 'account', 'system']));
    expect(sorted(symbols.ORDER_EVENT_ACTOR_TYPES)).toEqual(
      sorted(['staff', 'client', 'customer', 'supplier', 'system', 'account']),
    );
    expect(sorted(symbols.LEDGER_ACTOR_TYPES)).toEqual(sorted(['staff', 'client', 'customer', 'system', 'account']));
    for (const word of ['account', 'client', 'customer']) expect(sorted(symbols.LEDGER_REF_TYPES)).toContain(word);
  });

  it('closes the rank kinds, the client statuses and the wallet actions', () => {
    expect(sorted(symbols.RANK_KINDS)).toEqual(['merchant', 'retail']);
    expect(sorted(symbols.CLIENT_GROUP_KINDS)).toEqual(['b2b', 'b2c_retail']);
    expect(sorted(symbols.WALLET_ACTIONS)).toEqual(['credit_limit', 'freeze', 'unfreeze']);
    // The final four: the expand migration converts pending and narrows the check.
    expect(sorted(symbols.CLIENT_STATUSES)).toEqual(['active', 'anonymized', 'blocked', 'suspended']);
  });

  it('keeps one email unique among the rows with a login and, apart, among the guest rows', () => {
    for (const name of ['clients_login_email_uq', 'clients_guest_email_uq']) {
      const index = tableConfig('clients').indexes.find((candidate) => candidate.config.name === name);
      expect(index, name).toBeDefined();
      expect(index!.config.unique, name).toBe(true);
      expect(index!.config.where, `${name} is partial`).toBeDefined();
    }
    // The one index over every row is gone: a guest and a login row may share an email.
    expect(tableConfig('clients').indexes.find((index) => index.config.name === 'clients_email_uq')).toBeUndefined();
  });

  it('indexes the buyer account of orders, invoices and payments, and keeps an invoice key unique per account', () => {
    expect(indexNamed('orders', 'orders_account_created_idx')).toBeDefined();
    expect(indexNamed('invoices', 'invoices_account_created_idx')).toBeDefined();
    expect(indexNamed('payments', 'payments_account_id_idx')).toBeDefined();
    expect(isUnique('invoices', 'invoices_account_key_uq')).toBe(true);
  });

  it('declares the three history tables with their unique keys', () => {
    expect(isUnique('account_legacy_ids', 'account_legacy_ids_legacy_uq')).toBe(true);
    expect(indexNamed('account_legacy_ids', 'account_legacy_ids_account_idx')).toBeDefined();
    expect(isUnique('account_rank_changes', 'account_rank_changes_key_uq')).toBe(true);
    expect(isUnique('wallet_action_keys', 'wallet_action_keys_key_uq')).toBe(true);
  });

  it('gives the group ids of a rank change no foreign key, so a deleted rank leaves the history readable', () => {
    const foreign = new Set(
      tableConfig('account_rank_changes').foreignKeys.map((key) => casing.getColumnCasing(key.reference().columns[0]!)),
    );
    expect([...foreign].sort()).toEqual(['account_id', 'ledger_transaction_id', 'staff_id']);
  });

  it('renames the retired columns and tables in TypeScript only: the SQL names stay (decision 064, section 2.9)', () => {
    const column = (table: string, key: string): string => {
      const found = (symbols[table] as Record<string, unknown> | undefined)?.[key];
      if (found === undefined) throw new Error(`${table}.${key} is not exported by the schema`);
      return casing.getColumnCasing(found as never);
    };
    for (const table of ['orders', 'invoices']) {
      expect(column(table, 'legacyClientId'), table).toBe('client_id');
      expect(column(table, 'retiredCustomerId'), table).toBe('customer_id');
    }
    for (const table of [
      'payments',
      'refunds',
      'disputes',
      'checkoutSessions',
      'riskAssessments',
      'blocklistEntries',
      'dataRequests',
    ]) {
      expect(column(table, 'retiredCustomerId'), table).toBe('customer_id');
    }
    expect(nameOf(symbols.retiredCustomers as PgTable)).toBe('customers');
    expect(nameOf(symbols.retiredCustomerCredentials as PgTable)).toBe('customer_credentials');
  });
});
