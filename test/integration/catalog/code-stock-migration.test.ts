// Services sold as codes (backend decision 069), migration `_code_stock.sql`, on a database held right before it: a service that holds a
// code that is not void (available, reserved or sold) becomes a stock service, archived ones included; one whose codes are all void, or
// that never had one, stays off; a new service starts off; and a publish row may then be blocked `out_of_stock`.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import { CODE_STOCK_SUFFIX, ScratchDatabases, migrateUntil, poolOn } from '../../support/migration-files';
import { expectRejection } from '../../support/rejection';

setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('codestock');
let url = '';
let pool: Pool;
let categoryId = 0;
let serviceCount = 0;
let codeCount = 0;

beforeAll(async () => {
  const db = await scratch.create();
  url = db.url;
  await migrateUntil(url, CODE_STOCK_SUFFIX);
  pool = poolOn(url);
  const { rows } = await pool.query<{ id: string }>(
    "insert into service_categories (name, type) values ('Gift cards', 'server') returning id",
  );
  categoryId = Number(rows[0]!.id);
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await scratch.dropAll();
});

/** Inserts a service of the old shape holding codes of the given statuses; `archived` archives it (disabled, archived_at set). */
async function serviceWith(statuses: readonly string[], archived = false): Promise<number> {
  serviceCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into services (category_id, type, name, fulfillment, base_price, code, sla_minutes, status, archived_at)
     values ($1, 'server', $2, 'auto', 5, $3, 60, $4, $5) returning id`,
    [
      categoryId,
      `Gift card ${serviceCount}`,
      `GC-${serviceCount}`,
      archived ? 'disabled' : 'active',
      archived ? new Date() : null,
    ],
  );
  const serviceId = Number(rows[0]!.id);
  for (const status of statuses) {
    codeCount += 1;
    await pool.query(
      `insert into inventory_codes (service_id, code_enc, code_hash, code_last4, status, batch_ref)
       values ($1, $2, $3, 'abcd', $4, 'B-TEST')`,
      [serviceId, `enc-${codeCount}`, `hash-${codeCount}`, status],
    );
  }
  return serviceId;
}

const flagOf = async (serviceId: number) =>
  (await pool.query<{ stock_delivery: boolean }>('select stock_delivery from services where id = $1', [serviceId]))
    .rows[0]!.stock_delivery;

describe('the stored services', () => {
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ids.available = await serviceWith(['available', 'void']);
    ids.reserved = await serviceWith(['reserved']);
    ids.soldOut = await serviceWith(['sold', 'sold']);
    ids.allVoid = await serviceWith(['void', 'void']);
    ids.none = await serviceWith([]);
    ids.archived = await serviceWith(['sold'], true);
    expect(await migrateDatabase(url)).toBeGreaterThan(0);
  });

  it('makes a stock service of every service holding a code that is not void, archived ones included', async () => {
    for (const name of ['available', 'reserved', 'soldOut', 'archived'])
      expect(await flagOf(ids[name]!), name).toBe(true);
  });

  it('leaves a service whose codes are all void, or that never had one, off', async () => {
    for (const name of ['allVoid', 'none']) expect(await flagOf(ids[name]!), name).toBe(false);
  });

  it('starts a new service off', async () => {
    expect(await flagOf(await serviceWith([]))).toBe(false);
  });

  it('lets a publish row be blocked out_of_stock, and still refuses a reason that is not in the list', async () => {
    const { rows: runs } = await pool.query<{ id: string }>(
      `insert into listing_publish_runs (source, scope, total, rules_version, heartbeat_at)
       values ('console', '{"kind":"all"}', 1, 1, now()) returning id`,
    );
    const runId = Number(runs[0]!.id);
    const insertItem = (reason: string) =>
      pool.query(
        `insert into listing_publish_items (run_id, service_id, state, blocked_reason, included)
         values ($1, $2, 'blocked', $3, false)`,
        [runId, ids.none, reason],
      );
    await insertItem('out_of_stock');
    await expectRejection(insertItem('sold_out'), /listing_publish_items_blocked_reason_check/);
  });
});
