// Orders tables (map domain D): orders (one engine for B2B and B2C) and their append-only timeline.
// Conventions: decisions 010, 025, 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { bigId, createdAt, fk, inList, jsonObject, money, pk, timestampTz, updatedAt } from '../../../infra/db/columns';
import { SERVICE_TYPES, services, type ServiceType } from '../../catalog/db/schema';
import { checkoutSessions, retiredCustomers } from '../../customers/db/schema';
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
 * Internal dispatch state of an order: waiting for the job, being sent (the claim set it with `sent_at`; the supplier's
 * answer is awaited), held for risk review, manual, accepted by staff, sent to a supplier, needs attention, or done.
 *
 * Why: decisions 025 and 044.
 */
export const ORDER_DISPATCH_STATES = [
  'pending',
  'dispatching',
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
 * Why: decision 025 and MISMATCHES B12 (the map's example `rest_api` is stored as `v1`). `v1` is kept for the orders that the retired
 * REST API v1 placed: old rows carry it, nothing writes it any more.
 *
 * `admin` is retired (decision 062): no surface places an order with it any more (see `PlacedOrderSource` of the placement rules); the value
 * stays in the list because the check constraint and the readers must accept an old row.
 */
export const ORDER_SOURCES = ['dhru', 'v1', 'portal', 'store', 'admin'] as const;

/** One value of {@link ORDER_SOURCES}. */
export type OrderSource = (typeof ORDER_SOURCES)[number];

/**
 * Every actor word an order event row may hold, the old ones included; `system` has no id and `supplier` points at suppliers.id.
 *
 * Why: MISMATCHES B13 and the console's order event wire enum. The table is append-only, so the rows written before decision 064 keep
 * `client` and `customer` (read through `account_legacy_ids`) and the CHECK only gained `account`. New rows may write
 * {@link CURRENT_ORDER_EVENT_ACTOR_TYPES} only.
 */
export const ORDER_EVENT_ACTOR_TYPES = ['staff', 'client', 'customer', 'supplier', 'system', 'account'] as const;

/** One value of {@link ORDER_EVENT_ACTOR_TYPES}: what a stored row may say. */
export type OrderEventActorType = (typeof ORDER_EVENT_ACTOR_TYPES)[number];

/**
 * The actor words a new order event may write; `order_events_actor_type_current_check` refuses the old ones in new rows.
 *
 * Why: decision 064: one word, `account`, for every buyer. The constraint is added NOT VALID, so the old rows stay.
 */
export const CURRENT_ORDER_EVENT_ACTOR_TYPES = ['staff', 'account', 'supplier', 'system'] as const;

/** One value of {@link CURRENT_ORDER_EVENT_ACTOR_TYPES}: what a writer may pass. */
export type CurrentOrderEventActorType = (typeof CURRENT_ORDER_EVENT_ACTOR_TYPES)[number];

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
 * Orders; id equals REFERENCEID. `account_id` is the buyer of every order; the door is `source` (`store` is a prepaid order, the rest are
 * hold-and-settle orders).
 *
 * Why: The single order engine for B2B and B2C: id is the Dhru REFERENCEID (decision 025, scenarios success, reject,
 * manual, timeout, b2c-*). Decision 064: one buyer column for both doors; `client_id` is still written for hold-and-settle orders, as
 * the same value, until the contract migration drops it.
 */
export const orders = pgTable(
  'orders',
  {
    id: pk(),
    /** the buyer: an account of any rank (the door is `source`, never a null in another column) */
    accountId: fk((): AnyPgColumn => clients.id).notNull(),
    /**
     * the merchant of a hold-and-settle order (the same value as `account_id`; null for a `store` order): written during the expand
     * release for the readers of the old image, never read (the SQL column is `client_id`); the contract migration drops it
     */
    legacyClientId: bigint('client_id', { mode: 'number' }).references((): AnyPgColumn => clients.id, {
      onDelete: 'restrict',
    }),
    /** the old customer id: retired (decision 064), unread and unwritten (the SQL column is `customer_id`); the contract migration drops it */
    retiredCustomerId: bigint('customer_id', { mode: 'number' }).references((): AnyPgColumn => retiredCustomers.id, {
      onDelete: 'restrict',
    }),
    serviceId: fk((): AnyPgColumn => services.id).notNull(),
    type: text().$type<ServiceType>().notNull(),
    source: text().$type<OrderSource>().notNull(),
    /** the merchant key that placed the order (Dhru; the retired REST API v1 also set it) */
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
    /** the tracking token as issued: only orders placed before decision 054, until the seal pass empties it; unique */
    publicToken: text(),
    /** the lookup hash of the tracking token (CapabilityTokenVault.hashOf('tracking', …), decision 054); unique */
    publicTokenHash: text(),
    /** the tracking token as AES-GCM text, AAD orders.public_token_enc (decisions 019, 054) */
    publicTokenEnc: text(),
    checkoutSessionId: fk((): AnyPgColumn => checkoutSessions.id),
    taxAmount: money().notNull().default('0'),
    taxCountry: text(),
    supplierId: fk((): AnyPgColumn => suppliers.id),
    supplierServiceId: fk((): AnyPgColumn => supplierServices.id),
    /** the supplier's REFERENCEID, kept as text */
    supplierRef: text(),
    resultCode: text(),
    resultComment: text(),
    /** Retired (decision 062): no route writes or reads the buyer's note; the accounts migration drops it. */
    clientNote: text(),
    adminNote: text(),
    /** requested when the buyer asks for verification, then accepted or refunded by staff; null when none */
    verificationStatus: text().$type<OrderVerificationStatus>(),
    /** Retired with REST API v1 (decision 062): unread and unwritten (the portal's key lives in `idempotency_keys` only); the accounts migration drops it. */
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
    uniqueIndex('orders_public_token_hash_uq')
      .on(t.publicTokenHash)
      .where(sql`${t.publicTokenHash} is not null`),
    // Decision 054: an order never keeps both forms of its tracking token, and a hash always comes with its encrypted copy.
    check('orders_public_token_form_check', sql`${t.publicToken} is null or ${t.publicTokenHash} is null`),
    check('orders_public_token_enc_check', sql`(${t.publicTokenHash} is null) = (${t.publicTokenEnc} is null)`),
    uniqueIndex('orders_client_idempotency_uq')
      .on(t.legacyClientId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    check('orders_type_check', inList(t.type, SERVICE_TYPES)),
    check('orders_source_check', inList(t.source, ORDER_SOURCES)),
    check('orders_status_check', inList(t.status, ORDER_STATUSES)),
    check('orders_dispatch_state_check', inList(t.dispatchState, ORDER_DISPATCH_STATES)),
    check(
      'orders_verification_status_check',
      sql`${t.verificationStatus} is null or ${inList(t.verificationStatus, ORDER_VERIFICATION_STATUSES)}`,
    ),
    // Retired with REST API v1 (decision 062): nothing reads this index any more (the daily `idempotency_purge` used it to find keyed orders); the accounts migration drops it.
    index('orders_idempotency_placed_idx')
      .on(t.placedAt)
      .where(sql`${t.idempotencyKey} is not null`),
    index('orders_client_created_idx').on(t.legacyClientId, t.createdAt.desc()),
    index('orders_customer_created_idx').on(t.retiredCustomerId, t.createdAt.desc()),
    index('orders_account_created_idx').on(t.accountId, t.createdAt.desc()),
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
    // The merchant column, while it lasts, always repeats the buyer; the door decides whether it is set.
    check('orders_hold_buyer_check', sql`${t.legacyClientId} is null or ${t.legacyClientId} = ${t.accountId}`),
    check('orders_door_check', sql`(${t.source} = 'store') = (${t.legacyClientId} is null)`),
    check('orders_quantity_check', sql`${t.quantity} > 0`),
    check(
      'orders_amounts_check',
      sql`${t.unitPrice} >= 0 and ${t.totalPrice} >= 0 and ${t.unitCost} >= 0 and ${t.totalCost} >= 0`,
    ),
    index('orders_api_key_id_idx').on(t.apiKeyId),
    index('orders_currency_idx').on(t.currency),
    // One order per checkout session (decision 048). A full index (it also serves the foreign key's checks); NULLs stay distinct, so
    // orders without a checkout session are not limited.
    uniqueIndex('orders_checkout_session_uq').on(t.checkoutSessionId),
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
    /** staff_users, clients (an account id) or suppliers by actor_type; a `customer` row of before decision 064 is read through `account_legacy_ids`; null for the system */
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
    // Added NOT VALID by the expand migration: the rows of before stay, a new row writes the current words only.
    check('order_events_actor_type_current_check', inList(t.actorType, CURRENT_ORDER_EVENT_ACTOR_TYPES)),
    index('order_events_order_idx').on(t.orderId, t.id),
    check('order_events_actor_check', sql`(${t.actorType} = 'system') = (${t.actorId} is null)`),
  ],
);

/** A row read from `order_events`. */
export type OrderEvent = typeof orderEvents.$inferSelect;

/** A row to insert into `order_events`. */
export type NewOrderEvent = typeof orderEvents.$inferInsert;

/**
 * What an `Idempotency-Key` was used for: the merchant portal's placement (`portal`), or, in rows stored by the retired REST API v1, one
 * order (`order`) or a bulk of orders (`bulk`).
 *
 * Why: the scope is part of what the key stands for. `portal` (feature 24B) is `POST /client/orders`, whose stored answer is
 * `{ orders: [...] }`. `order` and `bulk` stay valid in the database check for the rows stored earlier; nothing writes them any more.
 */
export const IDEMPOTENCY_SCOPES = ['order', 'bulk', 'portal'] as const;

/** One value of {@link IDEMPOTENCY_SCOPES}. */
export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[number];

/**
 * The first answer of each merchant portal order placement that came with an `Idempotency-Key`.
 *
 * Why: decision 026 and brief 7a: the first result is stored with the key in Postgres, in the placement's own transaction, and replayed
 * for the same request; a different request with the same key is `409 IDEMPOTENCY_KEY_REUSED`. The row exists only when the placement
 * committed, so a refused or rolled-back attempt leaves nothing and the same key may be tried again. The key is unique per merchant and
 * remembered for 7 days (`IDEMPOTENCY_WINDOW_DAYS`): a placement that meets an older row deletes it, and the daily
 * job `idempotency_purge` does the same for keys nobody sends again (B166, P4a), so the key is free again. Not one of
 * the map's 66 tables: MISMATCHES B116 note (the backend's additions); the map's `idempotencyKey` rows describe only the header.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: pk(),
    clientId: fk((): AnyPgColumn => clients.id, 'cascade').notNull(),
    scope: text().$type<IdempotencyScope>().notNull(),
    /** the header as the merchant sent it (1 to 255 printable characters) */
    key: text().notNull(),
    /** keyed hash of the scope and the validated request body: the same key with another body is refused */
    requestHash: text().notNull(),
    /** the HTTP status to replay */
    status: integer().notNull(),
    /** the body to replay */
    response: jsonObject(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('idempotency_keys_client_key_uq').on(t.clientId, t.key),
    // The daily `idempotency_purge` deletes the rows older than the window (P4a, B166).
    index('idempotency_keys_created_idx').on(t.createdAt),
    check('idempotency_keys_scope_check', inList(t.scope, IDEMPOTENCY_SCOPES)),
  ],
);

/** A row read from `idempotency_keys`. */
export type IdempotencyRecord = typeof idempotencyKeys.$inferSelect;
