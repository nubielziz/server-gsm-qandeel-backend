// Suppliers tables (map domain C): connections, their synced services, links to our services, the call log.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  bigId,
  createdAt,
  fk,
  fxRate,
  inList,
  jsonList,
  jsonObject,
  money,
  pk,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { services } from '../../catalog/db/schema';
import { orders } from '../../orders/db/schema';

/**
 * Supplier states; `paused` stops new orders and routing skips it, `disabled` is the permanent switch-off.
 *
 * Why: the console's supplier wire enum and MISMATCHES B93.
 */
export const SUPPLIER_STATUSES = ['active', 'disabled', 'paused'] as const;

/** One value of {@link SUPPLIER_STATUSES}. */
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

/**
 * The connection drivers a supplier can use: Dhru-compatible API or a REST/JSON one.
 *
 * Why: RESOLUTIONS orders-suppliers-9: POST /admin/suppliers accepts these two; a new driver needs code and a migration.
 */
export const SUPPLIER_DRIVERS = ['dhru', 'rest'] as const;

/** One value of {@link SUPPLIER_DRIVERS}. */
export type SupplierDriver = (typeof SUPPLIER_DRIVERS)[number];

/**
 * How a driver sends parameters: Dhru's XML-style form post or JSON.
 *
 * Why: RESOLUTIONS orders-suppliers-9: the writer derives it from the driver, so the console never sends it.
 */
export const SUPPLIER_PARAM_FORMATS = ['dhru_xml', 'json'] as const;

/** One value of {@link SUPPLIER_PARAM_FORMATS}. */
export type SupplierParamFormat = (typeof SUPPLIER_PARAM_FORMATS)[number];

/**
 * How one supplier call ended: answered (`ok`), failed (`error`) or got no answer in time (`timeout`).
 *
 * Why: RESOLUTIONS health-commissions-8: the supplier health figures count errors and timeouts apart.
 */
export const SUPPLIER_CALL_OUTCOMES = ['ok', 'error', 'timeout'] as const;

/** One value of {@link SUPPLIER_CALL_OUTCOMES}. */
export type SupplierCallOutcome = (typeof SUPPLIER_CALL_OUTCOMES)[number];

/**
 * Supplier connections and your balance with each one.
 *
 * Why: Supplier connections and our prepaid balance with each (scenarios success, reject, timeout, system-alert).
 */
export const suppliers = pgTable(
  'suppliers',
  {
    id: pk(),
    name: text().notNull(),
    driver: text().$type<SupplierDriver>().notNull(),
    baseUrl: text().notNull(),
    username: text().notNull().default(''),
    /** write-only key, AES-GCM text of decision 019 */
    apiKeyEnc: text(),
    /** last characters of the key so the console can show which one is set; null until a key is saved (orders-suppliers-4) */
    apiKeyHint: text(),
    /** how the driver sends parameters; the writer derives it from the driver, so there is no default */
    paramFormat: text().$type<SupplierParamFormat>().notNull(),
    /** the supplier's credit currency; free text, not a reference to currencies */
    currency: text().notNull().default('USD'),
    /** base-currency value of one supplier credit */
    creditRate: fxRate().notNull().default('1'),
    status: text().$type<SupplierStatus>().notNull().default('active'),
    balance: money().notNull().default('0'),
    balanceCheckedAt: timestampTz(),
    /** when the last successful price sync finished; null before the first one (health-commissions-8) */
    pricesSyncedAt: timestampTz(),
    lowBalanceAlert: money().notNull().default('150'),
    maxConcurrency: integer().notNull().default(5),
    rateLimitPerMin: integer().notNull().default(60),
    timeoutMs: integer().notNull().default(15000),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('suppliers_status_check', inList(t.status, SUPPLIER_STATUSES)),
    check('suppliers_driver_check', inList(t.driver, SUPPLIER_DRIVERS)),
    check('suppliers_param_format_check', inList(t.paramFormat, SUPPLIER_PARAM_FORMATS)),
    check('suppliers_limits_check', sql`${t.maxConcurrency} > 0 and ${t.rateLimitPerMin} > 0 and ${t.timeoutMs} > 0`),
    index('suppliers_status_idx').on(t.status),
  ],
);

/** A row read from `suppliers`. */
export type Supplier = typeof suppliers.$inferSelect;

/** A row to insert into `suppliers`. */
export type NewSupplier = typeof suppliers.$inferInsert;

/**
 * A copy of a supplier's services after a sync.
 *
 * Why: The synced copy of a supplier's services, imported into our catalogue (routes /admin/suppliers/:id/services).
 */
export const supplierServices = pgTable(
  'supplier_services',
  {
    id: pk(),
    /** a deleted supplier takes its synced copy with it */
    supplierId: fk((): AnyPgColumn => suppliers.id, 'cascade').notNull(),
    /** the supplier's service id, kept as text */
    remoteId: text().notNull(),
    remoteGroup: text().notNull().default(''),
    /** the supplier's own type name; no source fixes the values */
    type: text().notNull(),
    name: text().notNull(),
    /** price in supplier credits */
    credit: money().notNull().default('0'),
    /** delivery time text from the supplier */
    time: text().notNull().default(''),
    requires: jsonObject(),
    customFields: jsonList(),
    raw: jsonObject(),
    isAvailable: boolean().notNull().default(true),
    lastSeenAt: timestampTz().notNull().defaultNow(),
    priceChangedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('supplier_services_remote_uq').on(t.supplierId, t.remoteId),
    index('supplier_services_available_idx').on(t.supplierId, t.isAvailable),
    index('supplier_services_supplier_name_idx').on(t.supplierId, t.name),
  ],
);

/** A row read from `supplier_services`. */
export type SupplierService = typeof supplierServices.$inferSelect;

/** A row to insert into `supplier_services`. */
export type NewSupplierService = typeof supplierServices.$inferInsert;

/**
 * Links your service to a supplier service, in priority order.
 *
 * Why: Routes one of our services to supplier services in priority order (route PUT
 * /admin/services/:id/supplier-links).
 */
export const serviceSupplierLinks = pgTable(
  'service_supplier_links',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    /** FK declared below with an explicit name: the generated one would exceed Postgres' 63-character limit. */
    supplierServiceId: bigId().notNull(),
    priority: integer().notNull().default(1),
    /** our field key to the supplier's field name */
    fieldMap: jsonObject(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_supplier_links_uq').on(t.serviceId, t.supplierServiceId),
    foreignKey({
      name: 'service_supplier_links_supplier_service_fk',
      columns: [t.supplierServiceId],
      foreignColumns: [supplierServices.id],
    }).onDelete('restrict'),
    index('service_supplier_links_routing_idx').on(t.serviceId, t.priority),
    index('service_supplier_links_supplier_service_idx').on(t.supplierServiceId),
  ],
);

/** A row read from `service_supplier_links`. */
export type ServiceSupplierLink = typeof serviceSupplierLinks.$inferSelect;

/** A row to insert into `service_supplier_links`. */
export type NewServiceSupplierLink = typeof serviceSupplierLinks.$inferInsert;

/**
 * A log of every request sent to a supplier.
 *
 * Why: Every call sent to a supplier, for support and the supplier health figures (routes /admin/supplier-api-logs).
 *
 * Immutable log: rows are inserted and never changed, so the table has no `updated_at`.
 */
export const supplierApiLogs = pgTable(
  'supplier_api_logs',
  {
    id: pk(),
    supplierId: fk((): AnyPgColumn => suppliers.id).notNull(),
    orderId: fk((): AnyPgColumn => orders.id),
    /** the supplier API action, for example placeimeiorder */
    action: text().notNull(),
    /** credentials are never stored */
    request: jsonb().$type<Record<string, unknown>>(),
    response: jsonb().$type<Record<string, unknown>>(),
    /** 0 when the supplier gave no HTTP answer (timeout, connection refused) */
    httpStatus: integer().notNull().default(0),
    /** the time waited, always measured by the outbound client */
    durationMs: integer().notNull().default(0),
    /** the reason of a failure; empty for a successful call */
    error: text().notNull().default(''),
    outcome: text().$type<SupplierCallOutcome>().notNull().default('ok'),
    createdAt: createdAt(),
  },
  (t) => [
    check('supplier_api_logs_numbers_check', sql`${t.httpStatus} >= 0 and ${t.durationMs} >= 0`),
    check('supplier_api_logs_outcome_check', inList(t.outcome, SUPPLIER_CALL_OUTCOMES)),
    index('supplier_api_logs_supplier_created_idx').on(t.supplierId, t.createdAt.desc()),
    index('supplier_api_logs_order_id_idx').on(t.orderId),
  ],
);

/** A row read from `supplier_api_logs`. */
export type SupplierApiLog = typeof supplierApiLogs.$inferSelect;

/** A row to insert into `supplier_api_logs`. */
export type NewSupplierApiLog = typeof supplierApiLogs.$inferInsert;
