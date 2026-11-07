// Seeder of the suppliers module: the demo's suppliers, the services each offers (the demo's services with their primary and fallback
// supplier, plus three unimported ones per supplier), the links of the services to them in priority order and the supplier call log,
// mapped as the frontend mock maps them (src/features/suppliers/mocks/seed.ts): same ids, names and amounts. API keys are the demo's
// dev-only placeholders, stored encrypted like real ones; no real secret is ever seeded.
//
// Two steps because of the foreign keys: the suppliers, services and links come before the orders (the orders seed links each order to
// its supplier by name), the call log after them (its rows point at orders).
import type { AppConfig } from '../../src/config';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { recomputeEffectiveCost } from '../../src/modules/catalog';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A supplier of the demo seed. */
interface DemoSupplier {
  id: string;
  name: string;
  api: string;
  host: string;
  enabled: boolean;
  minBalance: number;
  lastSync: number;
  key: string;
}

/** A service of the demo seed (the fields the suppliers need). */
interface DemoService {
  id: string;
  name: string;
  type: 'IMEI' | 'Server' | 'Remote' | 'File';
  category: string;
  cost: number;
  sla: number;
  sup: string;
  fb: string | null;
}

/** A call of the demo's supplier log. */
interface DemoLog {
  id: number;
  sid: string;
  ts: number;
  path: string;
  code: number;
  ms: number;
  ref: string | null;
  msg: string;
}

/** The services each supplier offers that nothing is linked to yet (names, groups and types as the mock lists them). */
const EXTRAS: Readonly<Record<number, ReadonlyArray<readonly [string, string, string]>>> = {
  1: [
    ['Sprint USA Premium Unlock', 'USA', 'IMEI'],
    ['Telstra Australia Unlock', 'Australia', 'IMEI'],
    ['Rogers Canada Unlock', 'Canada', 'IMEI'],
  ],
  2: [
    ['Octoplus Credits x25', 'Credits', 'SERVER'],
    ['Infinity-Box Credits x30', 'Credits', 'SERVER'],
    ['Medusa Pro Credits x10', 'Credits', 'SERVER'],
  ],
  3: [
    ['IMEI Carrier Check (All Brands)', 'Checks', 'IMEI'],
    ['Samsung Knox Guard Status', 'Checks', 'IMEI'],
    ['Apple SimLock Check', 'Checks', 'IMEI'],
  ],
  4: [
    ['Honor Account Remote', 'Remote', 'REMOTE'],
    ['Oppo FRP Remote', 'Remote', 'REMOTE'],
    ['Vivo FRP Remote', 'Remote', 'REMOTE'],
  ],
  5: [
    ['Samsung Modem File', 'Files', 'FILE'],
    ['Oppo Flash Pack', 'Files', 'FILE'],
    ['Realme Auth File', 'Files', 'FILE'],
  ],
  6: [
    ['Telekom Germany Unlock', 'Europe', 'IMEI'],
    ['Turkcell Turkey Unlock', 'Turkey', 'IMEI'],
    ['Movistar Spain Unlock', 'Europe', 'IMEI'],
  ],
};

/** The demo's call paths as the supplier actions the log shows. */
const ACTIONS: Readonly<Record<string, string>> = {
  '/placeorder': 'placeimeiorder',
  '/getorder': 'getimeiorder',
  '/balance': 'accountinfo',
};

/** The supplier's own delivery time text for a service, from its SLA in minutes (the mock's `deliveryText`). */
function deliveryText(minutes: number): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (minutes >= 1440) return plural(Math.round(minutes / 1440), 'day');
  return minutes >= 60 ? plural(Math.round(minutes / 60), 'hour') : `${minutes} min`;
}

/**
 * Seeds the suppliers, their services and the links of the demo's services.
 *
 * Why: seed = frontend mocks (decision 014): the Suppliers page, the service editor's chain and the orders read model show the demo's
 * suppliers through the real API. Idempotent: rows that exist are skipped. After linking, the effective cost of every linked service is
 * recomputed (the primary supplier's price equals the service cost, so nothing moves).
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration; without it the API keys are left out (the keys need the encryption keyring)
 * @returns one report per table
 */
export async function seedSuppliers(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const encryption = config ? new EncryptionService(config) : undefined;
  const prepaid = (demo.state.prepaid ?? {}) as Record<string, number>;
  const demoSuppliers = demoRows<DemoSupplier>(demo, 'suppliers');
  const reports: SeedReport[] = [];

  const supplierRows = demoSuppliers.map((supplier): typeof s.suppliers.$inferInsert & { id: number } => {
    const driver = supplier.api.startsWith('Dhru') ? 'dhru' : 'rest';
    return {
      id: demoNumericId(supplier.id),
      name: supplier.name,
      driver,
      baseUrl: `https://${supplier.host}`,
      username: 'gsm-supply',
      apiKeyEnc: encryption ? encryption.encrypt(supplier.key, 'suppliers.api_key_enc') : null,
      apiKeyHint: encryption ? supplier.key.slice(0, 5) : null,
      paramFormat: driver === 'dhru' ? 'dhru_xml' : 'json',
      currency: 'USD',
      creditRate: '1',
      status: supplier.enabled ? 'active' : 'disabled',
      balance: toMoney(prepaid[supplier.id] ?? 0),
      balanceCheckedAt: toDate(supplier.lastSync),
      pricesSyncedAt: toDate(supplier.lastSync),
      lowBalanceAlert: toMoney(supplier.minBalance),
      createdAt: toDate(supplier.lastSync - 120 * DAY_MS)!,
    };
  });
  reports.push(await insertRows(db, s.suppliers, supplierRows));

  // The supplier services, numbered as the mock numbers them: the demo's services in order with their chain, then the extras.
  const now = demo.now;
  const serviceRows: Array<typeof s.supplierServices.$inferInsert & { id: number }> = [];
  const linkRows: Array<typeof s.serviceSupplierLinks.$inferInsert> = [];
  const linkedServices: number[] = [];
  const changedMarked = new Set<number>();
  const add = (supplierId: number, name: string, group: string, type: string, credit: string, time: string) => {
    const id = serviceRows.length + 1;
    serviceRows.push({
      id,
      supplierId,
      remoteId: `${supplierId}${String(id).padStart(4, '0')}`,
      remoteGroup: group,
      type,
      name,
      credit,
      time,
      isAvailable: true,
      lastSeenAt: new Date(now - HOUR_MS),
    });
    return id;
  };
  for (const service of demoRows<DemoService>(demo, 'services')) {
    const serviceId = demoNumericId(service.id);
    const chain = [service.sup, service.fb].filter((supplier): supplier is string => Boolean(supplier));
    chain.forEach((demoSupplierId, index) => {
      const supplierId = demoNumericId(demoSupplierId);
      // A fallback charges a little more than the primary, so the two costs differ (the price protection limit has something to refuse).
      const credit = index === 0 ? toMoney(service.cost) : toMoney(service.cost * 1.08);
      const id = add(
        supplierId,
        service.name,
        service.category,
        service.type.toUpperCase(),
        credit,
        deliveryText(service.sla),
      );
      linkRows.push({ serviceId, supplierServiceId: id, priority: index + 1, fieldMap: {}, isActive: true });
      if (!changedMarked.has(supplierId)) {
        // One imported item per supplier shows a recent price change, without moving the cost the catalog seeded.
        changedMarked.add(supplierId);
        serviceRows[serviceRows.length - 1]!.priceChangedAt = new Date(now - 2 * DAY_MS);
      }
    });
    linkedServices.push(serviceId);
  }
  for (const supplier of demoSuppliers) {
    const supplierId = demoNumericId(supplier.id);
    for (const [index, [name, group, type]] of (EXTRAS[supplierId] ?? []).entries()) {
      add(supplierId, name, group, type, toMoney(2.5 + index * 1.75), `${(index + 1) * 2} hours`);
    }
  }
  reports.push(await insertRows(db, s.supplierServices, serviceRows));
  reports.push(await insertRows(db, s.serviceSupplierLinks, linkRows));
  await recomputeEffectiveCost(db, linkedServices);
  for (const table of [s.suppliers, s.supplierServices, s.serviceSupplierLinks]) await syncIdentity(db, table);
  return reports;
}

/**
 * Seeds the supplier call log of the demo.
 *
 * Why: the Suppliers page's Logs tab and the health figures read it. It runs after the orders seed because a call that belongs to an
 * order points at it; a call whose order is not seeded keeps no order.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report
 */
export async function seedSupplierLogs(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const suppliers = new Set((await db.select({ id: s.suppliers.id }).from(s.suppliers)).map((row) => row.id));
  const orderIds = new Set((await db.select({ id: s.orders.id }).from(s.orders)).map((row) => row.id));
  const rows = demoRows<DemoLog>(demo, 'apiLog').flatMap((log) => {
    const supplierId = demoNumericId(log.sid);
    if (!suppliers.has(supplierId)) return [];
    const action = ACTIONS[log.path] ?? 'accountinfo';
    const reference = log.ref && action !== 'accountinfo' ? demoNumericId(log.ref) : null;
    const orderId = reference !== null && orderIds.has(reference) ? reference : null;
    const worked = log.code === 200;
    return [
      {
        id: log.id,
        supplierId,
        orderId,
        action,
        request: {
          action,
          username: 'gsm-supply',
          apiaccesskey: '••••••••',
          ...(orderId === null ? {} : { parameters: { ID: String(orderId) } }),
        },
        response: worked
          ? { SUCCESS: [{ MESSAGE: 'OK', ...(orderId === null ? {} : { REFERENCEID: `R${orderId}` }) }] }
          : { ERROR: [{ MESSAGE: log.msg }] },
        httpStatus: log.code,
        durationMs: log.ms,
        error: worked ? '' : log.msg,
        outcome: worked
          ? ('ok' as const)
          : log.code === 504 || log.code === 408
            ? ('timeout' as const)
            : ('error' as const),
        createdAt: toDate(log.ts)!,
      },
    ];
  });
  const report = await insertRows(db, s.supplierApiLogs, rows);
  await syncIdentity(db, s.supplierApiLogs);
  return [report];
}
