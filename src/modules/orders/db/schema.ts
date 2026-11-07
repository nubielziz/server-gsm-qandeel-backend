// Orders tables (map domain D): orders (one engine for B2B and B2C) and their append-only timeline.
// Conventions: decisions 010, 025, 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { bigId, createdAt, fk, inList, jsonObject, money, pk, timestampTz, updatedAt } from '../../../infra/db/columns';
import { SERVICE_TYPES, services, type ServiceType } from '../../catalog/db/schema';
import { checkoutSessions, customers } from '../../customers/db/schema';
import { apiKeys, clients } from '../../identity/db/schema';
import { currencies } from '../../money/db/schema';
import { files } from '../../platform/db/schema';
import { suppliers, supplierServices } from '../../suppliers/db/schema';

/**
 * Order status as Dhru and the console see it (STATUS 0, 1, 4, 3); `rejected` is final.
 *
 * Why: decision 025.
 */
export const ORDER_STATUSES = ['pending', 'processing', 'completed', 'rejected'] as const;

/** One value of {@link ORDER_STATUSES}. */
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Internal dispatch state of an order: waiting for the job, held for risk review, manual, accepted by staff, sent to
 * a supplier, needs attention, or done.
 *
 * Why: decision 025.
 */
export const ORDER_DISPATCH_STATES = [
  'pending',
  'held',
  'manual',
  'operator',
  'sent',
  'needs_attention',
  'done',
] as const;

/** One value of {@link ORDER_DISPATCH_STATES}. */
export type OrderDispatchState = (typeof ORDER_DISPATCH_STATES)[number];

/**
 * Which surface placed the order.
 *
 * Why: decision 025 and MISMATCHES B12 (the map's example `rest_api` is stored as `v1`).
 */
export const ORDER_SOURCES = ['dhru', 'v1', 'portal', 'store', 'admin'] as const;

/** One value of {@link ORDER_SOURCES}. */
export type OrderSource = (typeof ORDER_SOURCES)[number];

/**
 * Who caused an order event; `system` has no id and `supplier` points at suppliers.id.
 *
 * Why: MISMATCHES B13 and the console's order event wire enum.
 */
export const ORDER_EVENT_ACTOR_TYPES = ['staff', 'client', 'customer', 'supplier', 'system'] as const;

/** One value of {@link ORDER_EVENT_ACTOR_TYPES}. */
export type OrderEventActorType = (typeof ORDER_EVENT_ACTOR_TYPES)[number];

/**
 * Where a buyer's verification request stands: `requested`, then `accepted` or `refunded` by staff. Null means none.
 *
 * Why: RESOLUTIONS orders-suppliers-14 and the console's order wire enum (verification after delivery).
 */
export const ORDER_VERIFICATION_STATUSES = ['requested', 'accepted', 'refunded'] as const;

/** One value of {@link ORDER_VERIFICATION_STATUSES}. */
export type OrderVerificationStatus = (typeof ORDER_VERIFICATION_STATUSES)[number];

/**
 * What happened to an order, one value per timeline line.
 *
 * Why: RESOLUTIONS orders-suppliers-15: the order engine's transitions (decision 025) and the console's timeline. The
 * list is closed on purpose; a new event type needs a migration.
 */
export const ORDER_EVENT_TYPES = [
  'created',
  'hold',
  'dispatch',
  'ack',
  'accepted',
  'completed',
  'settle',
  'rejected',
  'release',
  'refund',
  'retry',
  'review',
  'reopened',
  'supplier_changed',
  'verification',
  'note',
  'paid',
  'risk',
  'notify',
  'dispute',
  'fetch',
] as const;

/** One value of {@link ORDER_EVENT_TYPES}. */
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/**
 * Orders; id equals REFERENCEID. client_id accepts null for storefront (B2C) orders, which fill customer_id instead;
 * exactly one of the two is set.
 *
 * Why: The single order engine for B2B and B2C: id is the Dhru REFERENCEID (decision 025, scenarios success, reject,
 * manual, timeout, b2c-*).
 */
export const orders = pgTable(
  'orders',
  {
    id: pk(),
    /** B2B buyer; exactly one of client_id and customer_id is set */
    clientId: fk((): AnyPgColumn => clients.id),
    /** B2C buyer */
    customerId: fk((): AnyPgColumn => customers.id),
    serviceId: fk((): AnyPgColumn => services.id).notNull(),
    type: text().$type<ServiceType>().notNull(),
    source: text().$type<OrderSource>().notNull(),
    /** the merchant key that placed the order (v1, Dhru) */
    apiKeyId: fk((): AnyPgColumn => apiKeys.id),
    status: text().$type<OrderStatus>().notNull().default('pending'),
    dispatchState: text().$type<OrderDispatchState>().notNull().default('pending'),
    /**
     * main input of the order (IMEI, first required field, or file name); null only when erased or absent; sent as
     * empty string
     */
    imei: text(),
    quantity: integer().notNull().default(1),
    inputs: jsonObject(),
    unitPrice: money().notNull(),
    totalPrice: money().notNull(),
    unitCost: money().notNull().default('0'),
    totalCost: money().notNull().default('0'),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    /** how the price was resolved (client, group or base), kept for support */
    pricingSnapshot: jsonObject(),
    /** B2C tracking link token (decision 010); unique */
    publicToken: text(),
    checkoutSessionId: fk((): AnyPgColumn => checkoutSessions.id),
    taxAmount: money().notNull().default('0'),
    taxCountry: text(),
    supplierId: fk((): AnyPgColumn => suppliers.id),
    supplierServiceId: fk((): AnyPgColumn => supplierServices.id),
    /** the supplier's REFERENCEID, kept as text */
    supplierRef: text(),
    resultCode: text(),
    resultComment: text(),
    clientNote: text(),
    adminNote: text(),
    /** requested when the buyer asks for verification, then accepted or refunded by staff; null when none */
    verificationStatus: text().$type<OrderVerificationStatus>(),
    /** REST v1 Idempotency-Key, unique per merchant (decision 026) */
    idempotencyKey: text(),
    /** keyed hash of merchant, service and IMEI for the open-duplicate rule */
    fingerprint: text(),
    inputFileId: fk((): AnyPgColumn => files.id),
    resultFileId: fk((): AnyPgColumn => files.id),
    placedAt: timestampTz().notNull().defaultNow(),
    sentAt: timestampTz(),
    completedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_public_token_uq')
      .on(t.publicToken)
      .where(sql`${t.publicToken} is not null`),
    uniqueIndex('orders_client_idempotency_uq')
      .on(t.clientId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    check('orders_type_check', inList(t.type, SERVICE_TYPES)),
    check('orders_source_check', inList(t.source, ORDER_SOURCES)),
    check('orders_status_check', inList(t.status, ORDER_STATUSES)),
    check('orders_dispatch_state_check', inList(t.dispatchState, ORDER_DISPATCH_STATES)),
    check(
      'orders_verification_status_check',
      sql`${t.verificationStatus} is null or ${inList(t.verificationStatus, ORDER_VERIFICATION_STATUSES)}`,
    ),
    index('orders_client_created_idx').on(t.clientId, t.createdAt.desc()),
    index('orders_customer_created_idx').on(t.customerId, t.createdAt.desc()),
    index('orders_service_id_idx').on(t.serviceId),
    index('orders_created_idx').on(t.createdAt.desc()),
    index('orders_status_created_idx').on(t.status, t.createdAt.desc()),
    index('orders_supplier_status_idx').on(t.supplierId, t.status),
    index('orders_open_idx')
      .on(t.dispatchState, t.placedAt)
      .where(sql`${t.status} in ('pending', 'processing')`),
    index('orders_fingerprint_open_idx')
      .on(t.fingerprint)
      .where(sql`${t.fingerprint} is not null and ${t.status} in ('pending', 'processing')`),
    // The bulk reply preview matches pasted inputs with the whitespace removed on both sides (orders-suppliers-2).
    index('orders_imei_squashed_idx')
      .on(sql`regexp_replace(${t.imei}, '\\s', '', 'g')`)
      .where(sql`${t.imei} is not null and ${t.imei} <> ''`),
    index('orders_verification_idx')
      .on(t.completedAt)
      .where(sql`${t.verificationStatus} is not null`),
    check('orders_buyer_check', sql`(${t.clientId} is null) <> (${t.customerId} is null)`),
    check('orders_quantity_check', sql`${t.quantity} > 0`),
    check(
      'orders_amounts_check',
      sql`${t.unitPrice} >= 0 and ${t.totalPrice} >= 0 and ${t.unitCost} >= 0 and ${t.totalCost} >= 0`,
    ),
    index('orders_api_key_id_idx').on(t.apiKeyId),
    index('orders_currency_idx').on(t.currency),
    index('orders_checkout_session_id_idx').on(t.checkoutSessionId),
    index('orders_supplier_service_id_idx').on(t.supplierServiceId),
    index('orders_input_file_id_idx').on(t.inputFileId),
    index('orders_result_file_id_idx').on(t.resultFileId),
  ],
);

/** A row read from `orders`. */
export type Order = typeof orders.$inferSelect;

/** A row to insert into `orders`. */
export type NewOrder = typeof orders.$inferInsert;

/**
 * The order timeline; append only.
 *
 * Why: The order timeline: every transition writes one row in the same transaction (decision 025).
 *
 * Append-only: a trigger rejects UPDATE and DELETE (custom migration), so the table has no `updated_at`.
 */
export const orderEvents = pgTable(
  'order_events',
  {
    id: pk(),
    orderId: fk((): AnyPgColumn => orders.id).notNull(),
    type: text().$type<OrderEventType>().notNull(),
    fromStatus: text().$type<OrderStatus>(),
    toStatus: text().$type<OrderStatus>(),
    actorType: text().$type<OrderEventActorType>().notNull(),
    /** staff_users, clients, customers or suppliers by actor_type; null for the system */
    actorId: bigId(),
    /** event details, for example the review reason */
    data: jsonObject(),
    createdAt: createdAt(),
  },
  (t) => [
    check('order_events_type_check', inList(t.type, ORDER_EVENT_TYPES)),
    check('order_events_from_status_check', inList(t.fromStatus, ORDER_STATUSES)),
    check('order_events_to_status_check', inList(t.toStatus, ORDER_STATUSES)),
    check('order_events_actor_type_check', inList(t.actorType, ORDER_EVENT_ACTOR_TYPES)),
    index('order_events_order_idx').on(t.orderId, t.id),
    check('order_events_actor_check', sql`(${t.actorType} = 'system') = (${t.actorId} is null)`),
  ],
);

/** A row read from `order_events`. */
export type OrderEvent = typeof orderEvents.$inferSelect;

/** A row to insert into `order_events`. */
export type NewOrderEvent = typeof orderEvents.$inferInsert;
