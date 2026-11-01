// Risk tables (map domain K): IMEI checks, risk assessments, the blocklist and data-subject requests.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigId,
  createdAt,
  fk,
  inList,
  jsonList,
  jsonObject,
  money,
  pk,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { services, tacCatalog } from '../../catalog/db/schema';
import { checkoutSessions, customers } from '../../customers/db/schema';
import { staffUsers } from '../../identity/db/schema';
import { orders } from '../../orders/db/schema';
import { files } from '../../platform/db/schema';
import { suppliers } from '../../suppliers/db/schema';

/**
 * Which IMEI check was run.
 *
 * Why: the console's IMEI check wire enum (GET /admin/imei-checks).
 */
export const IMEI_CHECK_TYPES = ['blacklist', 'basic', 'icloud', 'sim_lock'] as const;

/** One value of {@link IMEI_CHECK_TYPES}. */
export type ImeiCheckType = (typeof IMEI_CHECK_TYPES)[number];

/**
 * Result of an IMEI check.
 *
 * Why: the console's IMEI check wire enum.
 */
export const IMEI_CHECK_STATUSES = ['clean', 'blacklisted', 'locked', 'unknown'] as const;

/** One value of {@link IMEI_CHECK_STATUSES}. */
export type ImeiCheckStatus = (typeof IMEI_CHECK_STATUSES)[number];

/**
 * Where an IMEI check was started: before an order or the free storefront tool.
 *
 * Why: the console's IMEI check wire enum.
 */
export const IMEI_CHECK_SOURCES = ['pre_order', 'storefront_free'] as const;

/** One value of {@link IMEI_CHECK_SOURCES}. */
export type ImeiCheckSource = (typeof IMEI_CHECK_SOURCES)[number];

/**
 * The decision of a risk assessment.
 *
 * Why: the map table description (allow, review or block).
 */
export const RISK_DECISIONS = ['allow', 'review', 'block'] as const;

/** One value of {@link RISK_DECISIONS}. */
export type RiskDecision = (typeof RISK_DECISIONS)[number];

/**
 * How staff closed a held order.
 *
 * Why: the console's risk queue wire enum (GET /admin/risk/queue).
 */
export const RISK_OUTCOMES = ['approved', 'refunded'] as const;

/** One value of {@link RISK_OUTCOMES}. */
export type RiskOutcome = (typeof RISK_OUTCOMES)[number];

/**
 * What a blocklist entry matches.
 *
 * Why: the console's blocklist wire enum (GET /admin/blocklist); IP addresses live in ip_rules.
 */
export const BLOCKLIST_KINDS = ['email', 'domain', 'imei', 'card', 'device', 'country'] as const;

/** One value of {@link BLOCKLIST_KINDS}. */
export type BlocklistKind = (typeof BLOCKLIST_KINDS)[number];

/**
 * Who added a blocklist entry.
 *
 * Why: the console's blocklist wire enum and scenario b2c-chargeback.
 */
export const BLOCKLIST_SOURCES = ['manual', 'auto', 'chargeback'] as const;

/** One value of {@link BLOCKLIST_SOURCES}. */
export type BlocklistSource = (typeof BLOCKLIST_SOURCES)[number];

/**
 * Data-subject request kinds.
 *
 * Why: the console's data request wire enum (B51).
 */
export const DATA_REQUEST_KINDS = ['export', 'erasure'] as const;

/** One value of {@link DATA_REQUEST_KINDS}. */
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];

/**
 * Life of a data-subject request.
 *
 * Why: the console's data request wire enum.
 */
export const DATA_REQUEST_STATUSES = ['open', 'in_progress', 'completed', 'rejected'] as const;

/** One value of {@link DATA_REQUEST_STATUSES}. */
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];

/**
 * IMEI checks: blacklist, lock and iCloud, free or before an order, with a cache.
 *
 * Why: IMEI checks (blacklist, lock, iCloud), free or before an order, cached by IMEI hash (routes
 * /admin/imei-checks).
 */
export const imeiChecks = pgTable(
  'imei_checks',
  {
    id: pk(),
    /** keyed hash of the IMEI, for cache lookups without decrypting; null after the customer is anonymised */
    imeiHash: text(),
    /** the IMEI, AES-GCM text of decision 019; null after the customer is anonymised (set together with imei_hash) */
    imeiEnc: text(),
    /** null when the TAC is not in the catalogue */
    tac: text().references((): AnyPgColumn => tacCatalog.tac, { onDelete: 'restrict' }),
    brand: text().notNull().default(''),
    model: text().notNull().default(''),
    /** ISO 3166-1 alpha-2 country of the device's carrier or origin when the check reports one (RESOLUTIONS b2c-3) */
    country: text(),
    checkType: text().$type<ImeiCheckType>().notNull(),
    status: text().$type<ImeiCheckStatus>().notNull().default('unknown'),
    result: jsonObject(),
    supplierId: fk((): AnyPgColumn => suppliers.id),
    serviceId: fk((): AnyPgColumn => services.id),
    customerId: fk((): AnyPgColumn => customers.id),
    checkoutSessionId: fk((): AnyPgColumn => checkoutSessions.id),
    source: text().$type<ImeiCheckSource>().notNull(),
    cost: money().notNull().default('0'),
    price: money().notNull().default('0'),
    ip: text(),
    cachedUntil: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('imei_checks_check_type_check', inList(t.checkType, IMEI_CHECK_TYPES)),
    check('imei_checks_status_check', inList(t.status, IMEI_CHECK_STATUSES)),
    check('imei_checks_source_check', inList(t.source, IMEI_CHECK_SOURCES)),
    check('imei_checks_country_check', sql`${t.country} is null or ${t.country} ~ '^[A-Z]{2}$'`),
    // Erasing a customer clears both IMEI columns together (RESOLUTIONS b2c-4).
    check('imei_checks_imei_erased_check', sql`(${t.imeiEnc} is null) = (${t.imeiHash} is null)`),
    index('imei_checks_imei_hash_idx').on(t.imeiHash, t.checkType, t.createdAt.desc()),
    index('imei_checks_source_created_idx').on(t.source, t.createdAt.desc()),
    index('imei_checks_created_idx').on(t.createdAt.desc()),
    index('imei_checks_tac_idx').on(t.tac),
    index('imei_checks_supplier_id_idx').on(t.supplierId),
    index('imei_checks_service_id_idx').on(t.serviceId),
    index('imei_checks_customer_id_idx').on(t.customerId),
    index('imei_checks_checkout_session_id_idx').on(t.checkoutSessionId),
  ],
);

/** A row read from `imei_checks`. */
export type ImeiCheck = typeof imeiChecks.$inferSelect;

/** A row to insert into `imei_checks`. */
export type NewImeiCheck = typeof imeiChecks.$inferInsert;

/**
 * Risk assessment of a session or an order: a score, signals and a decision (allow, review or block).
 *
 * Why: Risk score, signals and decision for a checkout or an order; held orders wait for a reviewer (routes
 * /admin/risk/queue).
 */
export const riskAssessments = pgTable(
  'risk_assessments',
  {
    id: pk(),
    checkoutSessionId: fk((): AnyPgColumn => checkoutSessions.id),
    orderId: fk((): AnyPgColumn => orders.id),
    customerId: fk((): AnyPgColumn => customers.id),
    score: integer().notNull(),
    decision: text().$type<RiskDecision>().notNull(),
    /** array of strings (the signals that raised the score) */
    signals: jsonList(),
    provider: text().notNull().default('internal'),
    reviewedBy: fk((): AnyPgColumn => staffUsers.id),
    reviewedAt: timestampTz(),
    outcome: text().$type<RiskOutcome>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('risk_assessments_decision_check', inList(t.decision, RISK_DECISIONS)),
    check('risk_assessments_outcome_check', inList(t.outcome, RISK_OUTCOMES)),
    index('risk_assessments_review_idx')
      .on(t.createdAt)
      .where(sql`${t.decision} = 'review' and ${t.reviewedAt} is null`),
    index('risk_assessments_order_id_idx').on(t.orderId),
    index('risk_assessments_checkout_session_id_idx').on(t.checkoutSessionId),
    index('risk_assessments_customer_id_idx').on(t.customerId),
    index('risk_assessments_reviewed_by_idx').on(t.reviewedBy),
  ],
);

/** A row read from `risk_assessments`. */
export type RiskAssessment = typeof riskAssessments.$inferSelect;

/** A row to insert into `risk_assessments`. */
export type NewRiskAssessment = typeof riskAssessments.$inferInsert;

/**
 * The blocklist: email, domain, IMEI, card fingerprint, device and country. IP addresses live in ip_rules.
 *
 * Why: Blocked emails, domains, IMEIs, cards, devices and countries, stored as hashes with a display form (routes
 * /admin/blocklist).
 */
export const blocklistEntries = pgTable(
  'blocklist_entries',
  {
    id: pk(),
    kind: text().$type<BlocklistKind>().notNull(),
    /** keyed hash of the normalised value */
    valueHash: text().notNull(),
    /** a masked form safe to show */
    display: text().notNull(),
    reason: text().notNull().default(''),
    expiresAt: timestampTz(),
    source: text().$type<BlocklistSource>().notNull().default('manual'),
    /** the customer a block came from (POST /admin/customers/:id/block); kept null if the customer is deleted (RESOLUTIONS b2c-5) */
    customerId: bigId().references((): AnyPgColumn => customers.id, { onDelete: 'set null' }),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('blocklist_entries_value_uq').on(t.kind, t.valueHash),
    check('blocklist_entries_kind_check', inList(t.kind, BLOCKLIST_KINDS)),
    check('blocklist_entries_source_check', inList(t.source, BLOCKLIST_SOURCES)),
    index('blocklist_entries_created_idx').on(t.createdAt.desc()),
    index('blocklist_entries_created_by_idx').on(t.createdBy),
    index('blocklist_entries_customer_id_idx').on(t.customerId),
  ],
);

/** A row read from `blocklist_entries`. */
export type BlocklistEntry = typeof blocklistEntries.$inferSelect;

/** A row to insert into `blocklist_entries`. */
export type NewBlocklistEntry = typeof blocklistEntries.$inferInsert;

/**
 * Data-subject requests: export or deletion, with a legal deadline.
 *
 * Why: Export and erasure requests with a legal deadline (routes /admin/data-requests, /store/v1/me/data-*).
 */
export const dataRequests = pgTable(
  'data_requests',
  {
    id: pk(),
    customerId: fk((): AnyPgColumn => customers.id).notNull(),
    kind: text().$type<DataRequestKind>().notNull(),
    status: text().$type<DataRequestStatus>().notNull().default('open'),
    requestedAt: timestampTz().notNull().defaultNow(),
    dueAt: timestampTz().notNull(),
    completedAt: timestampTz(),
    handledBy: fk((): AnyPgColumn => staffUsers.id),
    fileId: fk((): AnyPgColumn => files.id),
    /** schema addition B116 */
    note: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('data_requests_kind_check', inList(t.kind, DATA_REQUEST_KINDS)),
    check('data_requests_status_check', inList(t.status, DATA_REQUEST_STATUSES)),
    index('data_requests_status_due_idx').on(t.status, t.dueAt),
    index('data_requests_customer_id_idx').on(t.customerId),
    index('data_requests_handled_by_idx').on(t.handledBy),
    index('data_requests_file_id_idx').on(t.fileId),
  ],
);

/** A row read from `data_requests`. */
export type DataRequest = typeof dataRequests.$inferSelect;

/** A row to insert into `data_requests`. */
export type NewDataRequest = typeof dataRequests.$inferInsert;
