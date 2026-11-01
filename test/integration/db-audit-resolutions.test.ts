// The constraints that the pre-Phase-3 audit resolutions added (docs/contract/RESOLUTIONS.md, migration 0003): closed
// vocabularies, required columns, defaults, and the new unique and composite keys. Each test shows a value the database
// must accept next to one it must refuse, by SQLSTATE and constraint name.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { insertOrder, insertOrderParents, insertUsd } from '../support/fixtures';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../support/db';

beforeEach(resetDb);
afterAll(closeTestDb);

/** Runs one parameterised statement on the test database and returns its rows. */
async function run<Row = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<Row[]> {
  const { pool } = await testDb();
  return (await pool.query(text, params)).rows as Row[];
}

/** Expects the statement to fail a CHECK, unique or foreign key constraint with this name. */
async function refuses(text: string, params: unknown[], constraint: string, code = '23514'): Promise<void> {
  const { pool } = await testDb();
  const error = await pgErrorOf(pool.query(text, params));
  expect(error.constraint, error.message).toBe(constraint);
  expect(error.code).toBe(code);
}

/** Expects the statement to fail a NOT NULL constraint on this column. */
async function requires(text: string, params: unknown[], column: string): Promise<void> {
  const { pool } = await testDb();
  const error = await pgErrorOf(pool.query(text, params));
  expect(error.code).toBe('23502');
  expect(error.message).toContain(`"${column}"`);
}

/** The id returned by an insert. */
const idOf = (rows: Array<{ id: unknown }>) => Number(rows[0]!.id);

describe('identity and platform vocabularies', () => {
  const token = (purpose: string, hash: string) =>
    run(
      `insert into auth_tokens (purpose, subject_type, subject_id, token_hash, expires_at)
       values ($1, 'client', 1, $2, now() + interval '1 hour')`,
      [purpose, hash],
    );

  it('limit auth token purposes to invite, reset, verify_email and magic_link', async () => {
    for (const purpose of ['invite', 'reset', 'verify_email', 'magic_link']) await token(purpose, `hash-${purpose}`);
    await refuses(
      `insert into auth_tokens (purpose, subject_type, subject_id, token_hash, expires_at)
       values ('magic-link', 'client', 1, 'h', now())`,
      [],
      'auth_tokens_purpose_check',
    );
  });

  it('limit audit actors to staff, client, customer and system, and default the actor name to empty', async () => {
    const [row] = await run<{ actor_name: string }>(
      `insert into audit_logs (actor_type, action, entity_type, entity_id)
       values ('system', 'ran a job', 'job', 1) returning actor_name`,
    );
    expect(row!.actor_name).toBe('');
    await refuses(
      `insert into audit_logs (actor_type, action, entity_type, entity_id) values ('robot', 'x', 'job', 1)`,
      [],
      'audit_logs_actor_type_check',
    );
  });

  it('log notifications to staff, client or customer (a merchant is a client)', async () => {
    const insert = (recipient: string) =>
      run(
        `insert into notifications (recipient_type, recipient_id, channel, event) values ($1, 1, 'email', 'order.completed')`,
        [recipient],
      );
    for (const recipient of ['staff', 'client', 'customer']) await insert(recipient);
    await refuses(
      `insert into notifications (recipient_type, recipient_id, channel, event) values ('merchant', 1, 'email', 'e')`,
      [],
      'notifications_recipient_type_check',
    );
  });
});

describe('money', () => {
  it('point a ledger transaction at a known ref type, and never leave ref_id null', async () => {
    const insert = (refType: string, refId: number | null | undefined) =>
      run(
        refId === undefined
          ? `insert into ledger_transactions (kind, ref_type, idempotency_key, created_by_type)
             values ('deposit', $1, $2, 'system') returning ref_id`
          : `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type)
             values ('deposit', $1, $3, $2, 'system') returning ref_id`,
        refId === undefined ? [refType, `k-${refType}`] : [refType, `k-${refType}-${refId}`, refId],
      );
    // A system posting has no record to point at: ref_id defaults to 0.
    expect(Number((await insert('system', undefined))[0]!.ref_id)).toBe(0);
    await insert('order', 7);
    await refuses(
      `insert into ledger_transactions (kind, ref_type, idempotency_key, created_by_type)
       values ('deposit', 'order', 'k-no-ref', 'system')`,
      [],
      'ledger_transactions_ref_id_check',
    );
    await refuses(
      `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type)
       values ('deposit', 'order', 0, 'k-zero', 'system')`,
      [],
      'ledger_transactions_ref_id_check',
    );
    await requires(
      `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type)
       values ('deposit', 'system', null, 'k-null', 'system')`,
      [],
      'ref_id',
    );
    await refuses(
      `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type)
       values ('reversal', 'ledger_transaction', 1, 'k-rev', 'system')`,
      [],
      'ledger_transactions_ref_type_check',
    );
  });

  describe('payments', () => {
    async function gateway(): Promise<number> {
      await insertUsd((await testDb()).db);
      return idOf(
        await run(`insert into payment_gateways (code, driver, name) values ('g', 'manual', 'G') returning id`),
      );
    }
    const pay = (gatewayId: number, purpose: string, status: string, method: string) =>
      run(
        `insert into payments (purpose, gateway_id, amount, currency, status, method_type)
         values ($1, $2, 10, 'USD', $3, $4) returning brand, review_required, auto_credit_at, card_fingerprint`,
        [purpose, gatewayId, status, method],
      );

    it('give a top-up and an order payment their own statuses and methods', async () => {
      const gatewayId = await gateway();
      const [topup] = await pay(gatewayId, 'topup', 'pending', 'bank');
      await pay(gatewayId, 'topup', 'approved', 'wise');
      await pay(gatewayId, 'order', 'captured', 'wallet');
      await pay(gatewayId, 'order', 'chargeback', 'crypto');
      // the new columns default to "nothing to review, nothing scheduled"
      expect(topup).toEqual({ brand: '', review_required: false, auto_credit_at: null, card_fingerprint: null });

      await refuses(
        `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('topup', ${gatewayId}, 10, 'USD', 'captured', 'bank')`,
        [],
        'payments_status_check',
      );
      await refuses(
        `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('order', ${gatewayId}, 10, 'USD', 'approved', 'card')`,
        [],
        'payments_status_check',
      );
      await refuses(
        `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('topup', ${gatewayId}, 10, 'USD', 'pending', 'wallet')`,
        [],
        'payments_method_type_check',
      );
      await refuses(
        `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('order', ${gatewayId}, 10, 'USD', 'pending', 'bank')`,
        [],
        'payments_method_type_check',
      );
      // the union of both lists is the six values of RESOLUTIONS b2c-6
      await refuses(
        `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('order', ${gatewayId}, 10, 'USD', 'pending', 'cash')`,
        [],
        'payments_method_type_check',
      );
    });
  });

  it('require the invoice net amount and default the tax columns to zero or empty', async () => {
    await insertUsd((await testDb()).db);
    const [row] = await run(
      `insert into invoices (number, kind, amount, total, currency, net_amount) values ('INV-1', 'topup', 100, 100, 'USD', 97.5)
       returning tax_amount, tax_rate, tax_country, customer_vat_id`,
    );
    expect(row).toEqual({ tax_amount: '0.0000', tax_rate: '0.0000', tax_country: '', customer_vat_id: '' });
    await requires(
      `insert into invoices (number, kind, amount, total, currency) values ('INV-2', 'topup', 100, 100, 'USD')`,
      [],
      'net_amount',
    );
  });

  it('limit refund methods to original and manual, and give a storefront refund its payment and order', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const parents = await insertOrderParents(db);
    const insert = (method: string) =>
      run(
        `insert into refunds (amount, currency, method, requested_by_type, client_id) values (5, 'USD', $1, 'system', $2)`,
        [method, parents.clientId],
      );
    await insert('original');
    await insert('manual');
    await refuses(
      `insert into refunds (amount, currency, method, requested_by_type) values (5, 'USD', 'card', 'system')`,
      [],
      'refunds_method_check',
    );
    const [customer] = await run<{ id: number }>(`insert into customers (email) values ('c@example.com') returning id`);
    // a refund with a customer but without payment and order is refused
    await refuses(
      `insert into refunds (amount, currency, method, requested_by_type, customer_id)
       values (5, 'USD', 'original', 'system', $1)`,
      [customer!.id],
      'refunds_storefront_refs_check',
    );
  });

  it('allow 0 to 4 currency decimals', async () => {
    await run(`insert into currencies (code, name, decimals) values ('JPY', 'Yen', 0), ('KWD', 'Dinar', 4)`);
    await refuses(
      `insert into currencies (code, name, decimals) values ('XXX', 'Too fine', 5)`,
      [],
      'currencies_decimals_check',
    );
  });
});

describe('catalog', () => {
  it('require a positive base price and keep effective cost at or above cost', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const [category] = await run<{ id: number }>(`select id from service_categories limit 1`);
    const insert = (code: string, cost: string, basePrice: string | null, effectiveCost = cost) =>
      run(
        `insert into services (category_id, type, name, fulfillment, code, sla_minutes, cost, base_price, effective_cost)
         values ($1, 'imei', 'S', 'auto', $2, 60, $3, $4, $5) returning price_mode, duplicate_rule`,
        [category!.id, code, cost, basePrice, effectiveCost],
      );
    const [ok] = await insert('OK', '4', '5', '6');
    expect(ok).toEqual({ price_mode: 'fixed', duplicate_rule: 'block_open' });
    await refuses(
      `insert into services (category_id, type, name, fulfillment, code, sla_minutes, base_price) values (${category!.id}, 'imei', 'S', 'auto', 'ZERO', 60, 0)`,
      [],
      'services_prices_check',
    );
    await requires(
      `insert into services (category_id, type, name, fulfillment, code, sla_minutes) values (${category!.id}, 'imei', 'S', 'auto', 'NOPRICE', 60)`,
      [],
      'base_price',
    );
    await refuses(
      `insert into services (category_id, type, name, fulfillment, code, sla_minutes, cost, base_price, effective_cost)
       values (${category!.id}, 'imei', 'S', 'auto', 'LOW', 60, 5, 6, 4)`,
      [],
      'services_effective_cost_check',
    );
    expect(parents.serviceId).toBeGreaterThan(0);
  });

  it('close price mode and duplicate rule', async () => {
    await insertOrderParents((await testDb()).db);
    const [category] = await run<{ id: number }>(`select id from service_categories limit 1`);
    const base = `insert into services (category_id, type, name, fulfillment, code, sla_minutes, base_price, %COLS%) values (${category!.id}, 'imei', 'S', 'auto', 'X%N%', 60, 5, %VALS%)`;
    await run(base.replace('%COLS%', 'duplicate_rule').replace('%VALS%', `'allow'`).replace('%N%', '1'));
    await refuses(
      base.replace('%COLS%', 'price_mode').replace('%VALS%', `'margin'`).replace('%N%', '2'),
      [],
      'services_price_mode_check',
    );
    await refuses(
      base.replace('%COLS%', 'duplicate_rule').replace('%VALS%', `'bogus'`).replace('%N%', '3'),
      [],
      'services_duplicate_rule_check',
    );
  });

  it('archive only a disabled service, and give an archived service code back', async () => {
    const parents = await insertOrderParents((await testDb()).db);
    await refuses(
      `update services set archived_at = now() where id = $1`,
      [parents.serviceId],
      'services_archived_check',
    );
    await run(`update services set status = 'disabled', archived_at = now() where id = $1`, [parents.serviceId]);
    const [category] = await run<{ id: number }>(`select id from service_categories limit 1`);
    // the code IMEI-ICL-CHK is free again for a new live service, but only once
    const reuse = `insert into services (category_id, type, name, fulfillment, code, sla_minutes, base_price)
                   values (${category!.id}, 'imei', 'New', 'auto', 'imei-icl-chk', 60, 5)`;
    await run(reuse);
    await refuses(reuse, [], 'services_code_uq', '23505');
  });

  it('keep a service in the type of its category, and follow the category when its type changes', async () => {
    const parents = await insertOrderParents((await testDb()).db);
    const [server] = await run<{ id: number }>(
      `insert into service_categories (name, type) values ('Servers', 'server') returning id`,
    );
    await refuses(
      `insert into services (category_id, type, name, fulfillment, code, sla_minutes, base_price)
       values ($1, 'imei', 'Wrong', 'auto', 'WRONG', 60, 5)`,
      [server!.id],
      'services_category_type_fk',
      '23503',
    );
    // ON UPDATE CASCADE: retyping the category retypes its services
    const [category] = await run<{ id: number }>(`select category_id as id from services where id = $1`, [
      parents.serviceId,
    ]);
    await run(`update service_categories set type = 'remote' where id = $1`, [category!.id]);
    const [service] = await run<{ type: string }>(`select type from services where id = $1`, [parents.serviceId]);
    expect(service!.type).toBe('remote');
  });

  it('require a batch reference on inventory codes and number batches from one sequence', async () => {
    const parents = await insertOrderParents((await testDb()).db);
    const insert = (batch: string | null) =>
      run(
        `insert into inventory_codes (service_id, code_enc, code_hash, code_last4, batch_ref)
         values ($1, 'enc', $2, '1234', $3)`,
        [parents.serviceId, `hash-${batch}`, batch],
      );
    await insert('B-0001');
    await requires(
      `insert into inventory_codes (service_id, code_enc, code_hash, code_last4) values (${parents.serviceId}, 'enc', 'h-null', '1234')`,
      [],
      'batch_ref',
    );
    await refuses(
      `insert into inventory_codes (service_id, code_enc, code_hash, code_last4, batch_ref) values (${parents.serviceId}, 'enc', 'h-empty', '1234', '')`,
      [],
      'inventory_codes_batch_ref_check',
    );
    const first = Number((await run<{ n: string }>(`select nextval('inventory_batch_ref_seq') as n`))[0]!.n);
    const second = Number((await run<{ n: string }>(`select nextval('inventory_batch_ref_seq') as n`))[0]!.n);
    expect(second).toBe(first + 1);
  });

  it('keep merchant group amounts non-negative and the discount at most 100 percent', async () => {
    await run(`insert into client_groups (name, discount_percent, earn_threshold) values ('Gold', 100, 5000)`);
    await refuses(
      `insert into client_groups (name, discount_percent) values ('Too much', 100.5)`,
      [],
      'client_groups_amounts_check',
    );
    await refuses(
      `insert into client_groups (name, deposit_limit) values ('Negative', -1)`,
      [],
      'client_groups_amounts_check',
    );
  });
});

describe('orders', () => {
  it('limit the verification status to requested, accepted and refunded', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const orderId = await insertOrder(db, parents);
    for (const status of ['requested', 'accepted', 'refunded', null]) {
      await run(`update orders set verification_status = $1 where id = $2`, [status, orderId]);
    }
    await refuses(
      `update orders set verification_status = 'none' where id = $1`,
      [orderId],
      'orders_verification_status_check',
    );
  });

  it('limit order events to the types of the order engine', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const orderId = await insertOrder(db, parents);
    const insert = (type: string) =>
      run(`insert into order_events (order_id, type, actor_type) values ($1, $2, 'system')`, [orderId, type]);
    for (const type of ['created', 'supplier_changed', 'fetch']) await insert(type);
    await refuses(
      `insert into order_events (order_id, type, actor_type) values ($1, 'placed', 'system')`,
      [orderId],
      'order_events_type_check',
    );
  });
});

describe('suppliers', () => {
  it('default the connection limits and refuse unknown drivers, formats and non-positive limits', async () => {
    const [supplier] = await run(
      `insert into suppliers (name, driver, base_url, param_format) values ('S', 'dhru', 'https://s.example', 'dhru_xml')
       returning low_balance_alert, max_concurrency, rate_limit_per_min, timeout_ms, api_key_hint, prices_synced_at`,
    );
    expect(supplier).toEqual({
      low_balance_alert: '150.0000',
      max_concurrency: 5,
      rate_limit_per_min: 60,
      timeout_ms: 15000,
      api_key_hint: null,
      prices_synced_at: null,
    });
    await run(
      `insert into suppliers (name, driver, base_url, param_format) values ('R', 'rest', 'https://r.example', 'json')`,
    );
    await refuses(
      `insert into suppliers (name, driver, base_url, param_format) values ('X', 'Dhru', 'https://x.example', 'dhru_xml')`,
      [],
      'suppliers_driver_check',
    );
    await refuses(
      `insert into suppliers (name, driver, base_url, param_format) values ('X', 'dhru', 'https://x.example', 'xml')`,
      [],
      'suppliers_param_format_check',
    );
    await refuses(
      `insert into suppliers (name, driver, base_url, param_format, max_concurrency) values ('X', 'dhru', 'https://x.example', 'json', 0)`,
      [],
      'suppliers_limits_check',
    );
    await requires(
      `insert into suppliers (name, driver, base_url) values ('X', 'dhru', 'https://x.example')`,
      [],
      'param_format',
    );
  });

  it('log calls with a status, duration, error and outcome that are never null', async () => {
    const [supplier] = await run<{ id: number }>(
      `insert into suppliers (name, driver, base_url, param_format) values ('S', 'dhru', 'https://s.example', 'dhru_xml') returning id`,
    );
    const [log] = await run(
      `insert into supplier_api_logs (supplier_id, action) values ($1, 'balance') returning http_status, duration_ms, error, outcome`,
      [supplier!.id],
    );
    expect(log).toEqual({ http_status: 0, duration_ms: 0, error: '', outcome: 'ok' });
    for (const outcome of ['error', 'timeout']) {
      await run(`insert into supplier_api_logs (supplier_id, action, outcome) values ($1, 'balance', $2)`, [
        supplier!.id,
        outcome,
      ]);
    }
    await refuses(
      `insert into supplier_api_logs (supplier_id, action, outcome) values ($1, 'balance', 'slow')`,
      [supplier!.id],
      'supplier_api_logs_outcome_check',
    );
    await refuses(
      `insert into supplier_api_logs (supplier_id, action, duration_ms) values ($1, 'balance', -1)`,
      [supplier!.id],
      'supplier_api_logs_numbers_check',
    );
    await requires(
      `insert into supplier_api_logs (supplier_id, action, error) values ($1, 'balance', null)`,
      [supplier!.id],
      'error',
    );
  });
});

describe('system health', () => {
  async function rule(): Promise<number> {
    return idOf(
      await run(
        `insert into alert_rules (key, name, metric, comparator, threshold, window_seconds, severity)
         values ('r', 'High errors', 'api.error_rate', 'gt', 5, 300, 'warning') returning id`,
      ),
    );
  }
  /** An alert for the rule with the given unit and subject (omitted = the column default). */
  const alert = (ruleId: number, unit: string | null, subjectType?: string) =>
    run(
      `insert into alert_events (rule_id, rule_name, metric, comparator, threshold, window_seconds, severity, value, unit, subject_type)
       values ($1, 'High errors', 'api.error_rate', 'gt', 5, 300, 'warning', 7, $2, coalesce($3, 'system'))
       returning unit, subject_type`,
      [ruleId, unit, subjectType ?? null],
    );

  it('snapshot the rule in an alert, with a closed comparator, unit and subject', async () => {
    const ruleId = await rule();
    const [plain] = await alert(ruleId, null);
    expect(plain).toEqual({ unit: null, subject_type: 'system' });
    await alert(ruleId, 'ms', 'supplier');
    await refuses(
      `insert into alert_events (rule_id, rule_name, metric, comparator, threshold, window_seconds, severity, value)
       values ($1, 'n', 'm', 'eq', 5, 300, 'warning', 7)`,
      [ruleId],
      'alert_events_comparator_check',
    );
    await refuses(
      `insert into alert_events (rule_id, rule_name, metric, comparator, threshold, window_seconds, severity, value)
       values ($1, 'n', 'm', 'gt', 5, 0, 'warning', 7)`,
      [ruleId],
      'alert_events_window_check',
    );
    await refuses(
      `insert into alert_events (rule_id, rule_name, metric, comparator, threshold, window_seconds, severity, value, unit)
       values ($1, 'n', 'm', 'gt', 5, 300, 'warning', 7, 'kg')`,
      [ruleId],
      'alert_events_unit_check',
    );
    await refuses(
      `insert into alert_events (rule_id, rule_name, metric, comparator, threshold, window_seconds, severity, value, subject_type)
       values ($1, 'n', 'm', 'gt', 5, 300, 'warning', 7, 'planet')`,
      [ruleId],
      'alert_events_subject_type_check',
    );
  });

  it('allow one incident per alert and any number without one', async () => {
    const ruleId = await rule();
    await alert(ruleId, null);
    const alertId = idOf(await run<{ id: number }>(`select id from alert_events limit 1`));
    const open = (alertEventId: number | null) =>
      run(`insert into incidents (title, severity, alert_event_id) values ('I', 'minor', $1)`, [alertEventId]);
    await open(null);
    await open(null);
    await open(alertId);
    await refuses(
      `insert into incidents (title, severity, alert_event_id) values ('Again', 'minor', $1)`,
      [alertId],
      'incidents_alert_event_uq',
      '23505',
    );
  });

  it('name the checked record in the component of a check', async () => {
    const [supplier] = await run<{ id: number }>(
      `insert into suppliers (name, driver, base_url, param_format) values ('S', 'dhru', 'https://s.example', 'dhru_xml') returning id`,
    );
    const id = supplier!.id;
    await run(`insert into service_checks (component, status, supplier_id) values ($1, 'ok', $2)`, [
      `supplier:${id}`,
      id,
    ]);
    await run(`insert into service_checks (component, status, detail) values ('postgres', 'ok', null)`);
    await run(`insert into service_checks (component, status, detail) values ('redis', 'down', 'connection refused')`);
    await refuses(
      `insert into service_checks (component, status, supplier_id) values ('supplier:999', 'ok', $1)`,
      [id],
      'service_checks_supplier_key_check',
    );
    await insertUsd((await testDb()).db);
    const [gateway] = await run<{ id: number }>(
      `insert into payment_gateways (code, driver, name) values ('g', 'manual', 'G') returning id`,
    );
    await refuses(
      `insert into service_checks (component, status, gateway_id) values ('gateway:999', 'ok', $1)`,
      [gateway!.id],
      'service_checks_gateway_key_check',
    );
  });

  it('count job runs from zero and refuse negative figures', async () => {
    const [run1] = await run(
      `insert into job_runs (job, trigger) values ('price_sync', 'schedule') returning duration_ms, processed`,
    );
    expect(run1).toEqual({ duration_ms: 0, processed: 0 });
    await refuses(
      `insert into job_runs (job, trigger, processed) values ('price_sync', 'schedule', -1)`,
      [],
      'job_runs_counts_check',
    );
  });
});

describe('commissions', () => {
  async function setup() {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const orderA = await insertOrder(db, parents);
    const orderB = await insertOrder(db, parents);
    const plan = (name: string) =>
      run<{ id: number }>(
        `insert into commission_plans (name, kind, basis, period) values ($1, 'referral', 'revenue', 'monthly') returning id, tiers`,
        [name],
      );
    const [first] = await plan('Plan A');
    const [second] = await plan('Plan B');
    return { parents, orderA, orderB, planA: first!.id, planB: second!.id };
  }

  it('keep plan tiers an object that defaults to empty', async () => {
    const { planA } = await setup();
    const [row] = await run(`select tiers from commission_plans where id = $1`, [planA]);
    expect(row).toEqual({ tiers: {} });
    await run(`update commission_plans set tiers = '{"brackets": [{"from": 0, "percent": 2}]}' where id = $1`, [planA]);
    await refuses(`update commission_plans set tiers = '[]' where id = $1`, [planA], 'commission_plans_tiers_check');
  });

  it('allow one current assignment per merchant, whatever the plan', async () => {
    const { parents, planA, planB } = await setup();
    const assign = (planId: number, ended = false) =>
      run(
        `insert into commission_assignments (plan_id, beneficiary_id, scope, ends_at) values ($1, $2, 'all', ${ended ? 'now()' : 'null'})`,
        [planId, parents.clientId],
      );
    await assign(planA, true);
    await assign(planA);
    await refuses(
      `insert into commission_assignments (plan_id, beneficiary_id, scope) values ($1, $2, 'all')`,
      [planB, parents.clientId],
      'commission_assignments_current_uq',
      '23505',
    );
  });

  it('tie accruals to an order, a known status, and approval time', async () => {
    const { parents, orderA, orderB, planA } = await setup();
    const accrue = (orderId: number, status: string, approvedAt: string | null) =>
      run(
        `insert into commission_accruals (plan_id, beneficiary_id, order_id, period, basis_amount, percent, amount, status, approved_at)
         values ($1, $2, $3, '2026-11', 100, 2, 2, $4, $5)`,
        [planA, parents.clientId, orderId, status, approvedAt],
      );
    await accrue(orderA, 'accrued', null);
    await accrue(orderB, 'approved', new Date().toISOString());
    // a completed order accrues once per beneficiary, but a reversed accrual does not block a later one
    await refuses(
      `insert into commission_accruals (plan_id, beneficiary_id, order_id, period, basis_amount, percent, amount, status)
       values ($1, $2, $3, '2026-11', 100, 2, 2, 'accrued')`,
      [planA, parents.clientId, orderA],
      'commission_accruals_order_beneficiary_uq',
      '23505',
    );
    await accrue(orderA, 'reversed', null);
    await accrue(orderA, 'reversed', null);
    await requires(
      `insert into commission_accruals (plan_id, beneficiary_id, period, basis_amount, percent, amount, status)
       values ($1, $2, '2026-11', 100, 2, 2, 'accrued')`,
      [planA, parents.clientId],
      'order_id',
    );
    await refuses(
      `insert into commission_accruals (plan_id, beneficiary_id, order_id, period, basis_amount, percent, amount, status)
       values ($1, $2, $3, '2026-12', 100, 2, 2, 'paid')`,
      [planA, parents.clientId, orderB],
      'commission_accruals_status_check',
    );
    // approved exactly when approved_at is set
    await refuses(
      `insert into commission_accruals (plan_id, beneficiary_id, order_id, period, basis_amount, percent, amount, status)
       values ($1, $2, $3, '2026-12', 100, 2, 2, 'approved')`,
      [planA, parents.clientId, orderB],
      'commission_accruals_approved_at_check',
    );
    await refuses(
      `insert into commission_accruals (plan_id, beneficiary_id, order_id, period, basis_amount, percent, amount, status, approved_at)
       values ($1, $2, $3, '2026-12', 100, 2, 2, 'accrued', now())`,
      [planA, parents.clientId, orderB],
      'commission_accruals_approved_at_check',
    );
  });
});

describe('customers, storefront, support and risk', () => {
  it('open a checkout session by default and close its statuses', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const insert = (token: string, status?: string) =>
      run(
        `insert into checkout_sessions (token, email, service_id, currency, net_amount, gross_amount, expires_at${status ? ', status' : ''})
         values ($1, 'a@example.com', $2, 'USD', 5, 5, now() + interval '1 hour'${status ? ', $3' : ''}) returning status`,
        status ? [token, parents.serviceId, status] : [token, parents.serviceId],
      );
    expect((await insert('t1'))[0]).toEqual({ status: 'open' });
    for (const status of ['paid', 'expired']) await insert(`t-${status}`, status);
    await refuses(
      `insert into checkout_sessions (token, email, service_id, currency, net_amount, gross_amount, expires_at, status)
       values ('t2', 'a@example.com', ${parents.serviceId}, 'USD', 5, 5, now(), 'cancelled')`,
      [],
      'checkout_sessions_status_check',
    );
  });

  it('record consent with a known purpose and subject, and an IP address that is never null', async () => {
    const insert = (subject: string, purpose: string) =>
      run(`insert into consent_records (subject_type, subject_id, purpose, granted, ip) values ($1, 1, $2, true, '')`, [
        subject,
        purpose,
      ]);
    for (const purpose of ['terms', 'privacy', 'refund_policy', 'withdrawal_waiver', 'marketing']) {
      await insert('customer', purpose);
    }
    await insert('client', 'terms');
    await refuses(
      `insert into consent_records (subject_type, subject_id, purpose, ip) values ('customer', 1, 'cookies', '')`,
      [],
      'consent_records_purpose_check',
    );
    await refuses(
      `insert into consent_records (subject_type, subject_id, purpose, ip) values ('staff', 1, 'terms', '')`,
      [],
      'consent_records_subject_type_check',
    );
    await requires(
      `insert into consent_records (subject_type, subject_id, purpose) values ('customer', 1, 'terms')`,
      [],
      'ip',
    );
  });

  it('publish only terms, privacy, refund and cookies documents', async () => {
    for (const type of ['terms', 'privacy', 'refund', 'cookies']) {
      await run(`insert into legal_documents (type, version, body_md) values ($1, '1', 'body')`, [type]);
    }
    await refuses(
      `insert into legal_documents (type, version, body_md) values ('gdpr', '1', 'body')`,
      [],
      'legal_documents_type_check',
    );
  });

  it('end a ticket at resolved: there is no closed status', async () => {
    const insert = (number: string, status: string) =>
      run(
        `insert into support_tickets (number, subject, requester_type, requester_id, status) values ($1, 's', 'client', 1, $2)`,
        [number, status],
      );
    for (const [index, status] of ['new', 'open', 'pending_customer', 'resolved'].entries())
      await insert(`T-${index}`, status);
    await refuses(
      `insert into support_tickets (number, subject, requester_type, requester_id, status) values ('T-9', 's', 'client', 1, 'closed')`,
      [],
      'support_tickets_status_check',
    );
  });

  it('keep an IMEI check country as two capital letters, and erase the IMEI as a pair', async () => {
    const base = `insert into imei_checks (imei_hash, imei_enc, check_type, source, country) values ('h', 'e', 'basic', 'pre_order', $1)`;
    await run(base, ['US']);
    await run(base, [null]);
    for (const bad of ['us', 'USA', 'U1']) await refuses(base, [bad], 'imei_checks_country_check');

    // an anonymised customer's check has no IMEI at all, never one half of it
    await run(
      `insert into imei_checks (imei_hash, imei_enc, check_type, source) values (null, null, 'basic', 'pre_order')`,
    );
    await refuses(
      `insert into imei_checks (imei_hash, imei_enc, check_type, source) values ('h', null, 'basic', 'pre_order')`,
      [],
      'imei_checks_imei_erased_check',
    );
    await refuses(
      `insert into imei_checks (imei_hash, imei_enc, check_type, source) values (null, 'e', 'basic', 'pre_order')`,
      [],
      'imei_checks_imei_erased_check',
    );
  });

  it('remember which customer a block came from, and forget it when the customer is deleted', async () => {
    const [customer] = await run<{ id: number }>(`insert into customers (email) values ('x@example.com') returning id`);
    await run(
      `insert into blocklist_entries (kind, value_hash, display, customer_id) values ('email', 'h', 'x***', $1)`,
      [customer!.id],
    );
    await run(`delete from customers where id = $1`, [customer!.id]);
    const [entry] = await run(`select customer_id from blocklist_entries`);
    expect(entry).toEqual({ customer_id: null });
  });
});
