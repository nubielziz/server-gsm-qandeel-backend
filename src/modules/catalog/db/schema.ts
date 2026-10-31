// Catalog tables (map domain B): groups, services and their fields, options and prices, rules, codes, TAC list.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  bigId,
  bigintList,
  createdAt,
  fk,
  inList,
  intList,
  jsonObject,
  lower,
  money,
  percent,
  pk,
  textList,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { clients, staffUsers } from '../../identity/db/schema';
import { orders } from '../../orders/db/schema';

/**
 * The four Dhru service types (also the type of a service category and of an order).
 *
 * Why: the console's wire enum (GET /admin/services, /admin/service-categories, /admin/orders).
 */
export const SERVICE_TYPES = ['imei', 'server', 'remote', 'file'] as const;

/** One value of {@link SERVICE_TYPES}. */
export type ServiceType = (typeof SERVICE_TYPES)[number];

/**
 * A service is on sale (`active`) or not.
 *
 * Why: the console's service wire enum (GET /admin/services).
 */
export const SERVICE_STATUSES = ['active', 'disabled'] as const;

/** One value of {@link SERVICE_STATUSES}. */
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/**
 * How a service is fulfilled: through a supplier (`auto`) or by staff (`manual`).
 *
 * Why: the console's `executionMode` wire enum; MISMATCHES B21 maps it to services.fulfillment.
 */
export const FULFILLMENT_MODES = ['auto', 'manual'] as const;

/** One value of {@link FULFILLMENT_MODES}. */
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

/**
 * Input types of a custom service field.
 *
 * Why: the console's service field wire enum (PUT /admin/services/:id/fields).
 */
export const SERVICE_FIELD_TYPES = ['text', 'number', 'select', 'textarea'] as const;

/** One value of {@link SERVICE_FIELD_TYPES}. */
export type ServiceFieldType = (typeof SERVICE_FIELD_TYPES)[number];

/**
 * Which list a service option belongs to.
 *
 * Why: the console's service option wire enum (PUT /admin/services/:id/options).
 */
export const SERVICE_OPTION_LISTS = ['model', 'network', 'mep'] as const;

/** One value of {@link SERVICE_OPTION_LISTS}. */
export type ServiceOptionList = (typeof SERVICE_OPTION_LISTS)[number];

/**
 * What a pricing rule applies to.
 *
 * Why: the console's pricing rule wire enum (GET /admin/pricing-rules).
 */
export const PRICING_SCOPES = ['global', 'category', 'service'] as const;

/** One value of {@link PRICING_SCOPES}. */
export type PricingScope = (typeof PRICING_SCOPES)[number];

/**
 * Kinds of pricing rule.
 *
 * Why: the console's pricing rule wire enum.
 */
export const PRICING_RULE_KINDS = ['margin', 'discount', 'promo'] as const;

/** One value of {@link PRICING_RULE_KINDS}. */
export type PricingRuleKind = (typeof PRICING_RULE_KINDS)[number];

/**
 * How a computed price is rounded.
 *
 * Why: the console's pricing rule wire enum.
 */
export const PRICING_ROUNDINGS = ['none', 'nearest_0.05', 'nearest_0.10', 'ends_99'] as const;

/** One value of {@link PRICING_ROUNDINGS}. */
export type PricingRounding = (typeof PRICING_ROUNDINGS)[number];

/**
 * Life of a stocked code: reserved at placement, sold on completion, released on rejection; `void` is withdrawn.
 *
 * Why: decision 025 and the console's inventory wire enum (GET /admin/inventory-codes).
 */
export const INVENTORY_CODE_STATUSES = ['available', 'reserved', 'sold', 'void'] as const;

/** One value of {@link INVENTORY_CODE_STATUSES}. */
export type InventoryCodeStatus = (typeof INVENTORY_CODE_STATUSES)[number];

/**
 * Merchant groups with their discount percentages and promotion limits; kind = b2c_retail marks the single retail
 * group used by the storefront.
 *
 * Why: Merchant tiers with discounts and limits, plus the single storefront retail group (routes
 * /admin/client-groups).
 */
export const clientGroups = pgTable(
  'client_groups',
  {
    id: pk(),
    name: text().notNull(),
    /** `b2c_retail` marks the storefront's single retail group; the wire leaves the field a free string */
    kind: text().notNull().default('b2b'),
    discountPercent: percent().notNull().default('0'),
    isDefault: boolean().notNull().default(false),
    earnThreshold: money().notNull().default('0'),
    depositLimit: money().notNull().default('0'),
    overdraftAllowed: boolean().notNull().default(false),
    sort: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('client_groups_name_uq').on(lower(t.name)),
    uniqueIndex('client_groups_single_default_uq')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    uniqueIndex('client_groups_single_retail_uq')
      .on(t.kind)
      .where(sql`${t.kind} = 'b2c_retail'`),
  ],
);

/** A row read from `client_groups`. */
export type ClientGroup = typeof clientGroups.$inferSelect;

/** A row to insert into `client_groups`. */
export type NewClientGroup = typeof clientGroups.$inferInsert;

/**
 * Service categories; equal to GROUPNAME in Dhru.
 *
 * Why: Service groups (Dhru GROUPNAME) and which merchant groups may see them (routes /admin/service-categories).
 */
export const serviceCategories = pgTable(
  'service_categories',
  {
    id: pk(),
    name: text().notNull(),
    type: text().$type<ServiceType>().notNull(),
    /** client_groups.id; empty means every group */
    allowedGroupIds: bigintList(),
    sort: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('service_categories_name_uq').on(t.type, lower(t.name)),
    check('service_categories_type_check', inList(t.type, SERVICE_TYPES)),
  ],
);

/** A row read from `service_categories`. */
export type ServiceCategory = typeof serviceCategories.$inferSelect;

/** A row to insert into `service_categories`. */
export type NewServiceCategory = typeof serviceCategories.$inferInsert;

/**
 * Services; id equals SERVICEID.
 *
 * Why: The sellable catalogue; id is the Dhru SERVICEID (routes /admin/services, /client/services, Dhru
 * imeiservicelist).
 */
export const services = pgTable(
  'services',
  {
    id: pk(),
    categoryId: fk((): AnyPgColumn => serviceCategories.id).notNull(),
    type: text().$type<ServiceType>().notNull(),
    name: text().notNull(),
    info: text().notNull().default(''),
    /** display text; derived from sla_minutes by the writer */
    deliveryTime: text().notNull().default(''),
    status: text().$type<ServiceStatus>().notNull().default('active'),
    fulfillment: text().$type<FulfillmentMode>().notNull(),
    /** no source fixes the values (fixed price or margin over cost) */
    priceMode: text().notNull(),
    /** null when the price comes from rules only */
    basePrice: money(),
    cost: money().notNull().default('0'),
    costCurrency: text().notNull().default('USD'),
    minQty: integer().notNull().default(1),
    maxQty: integer().notNull().default(1),
    qtyOptions: intList(),
    allowFree: boolean().notNull().default(false),
    /** no source fixes the values (the map's duplicate-order rule) */
    duplicateRule: text().notNull(),
    allowCancel: boolean().notNull().default(false),
    allowVerify: boolean().notNull().default(false),
    verifyWindowH: integer().notNull().default(0),
    /** the Dhru `Requires` description */
    requires: jsonObject(),
    /** unique case-insensitively; schema addition B116 */
    code: text().notNull(),
    /** the past-SLA predicate needs a positive value; schema addition B116 */
    slaMinutes: integer().notNull(),
    /** null means the default policy; schema addition B116 */
    minProfit: money(),
    /** previous cost, to show a price change; schema addition B116 */
    costWas: money(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('services_code_uq').on(lower(t.code)),
    check('services_type_check', inList(t.type, SERVICE_TYPES)),
    check('services_status_check', inList(t.status, SERVICE_STATUSES)),
    check('services_fulfillment_check', inList(t.fulfillment, FULFILLMENT_MODES)),
    index('services_type_status_idx').on(t.type, t.status),
    check('services_qty_check', sql`${t.minQty} >= 1 and ${t.maxQty} >= ${t.minQty}`),
    check('services_prices_check', sql`${t.cost} >= 0 and (${t.basePrice} is null or ${t.basePrice} >= 0)`),
    check('services_sla_check', sql`${t.slaMinutes} > 0`),
    index('services_category_id_idx').on(t.categoryId),
    index('services_name_idx').on(t.name),
  ],
);

/** A row read from `services`. */
export type Service = typeof services.$inferSelect;

/** A row to insert into `services`. */
export type NewService = typeof services.$inferInsert;

/**
 * Custom fields of a service; equal to Requires.Custom.
 *
 * Why: Custom input fields of a service, sent as Dhru `Requires.Custom` (routes /admin/services/:id/fields).
 */
export const serviceFields = pgTable(
  'service_fields',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    key: text().notNull(),
    label: text().notNull(),
    fieldType: text().$type<ServiceFieldType>().notNull().default('text'),
    /** choices of a `select` field */
    options: textList(),
    required: boolean().notNull().default(false),
    regex: text().notNull().default(''),
    sort: integer().notNull().default(0),
    /** the field name the supplier expects */
    supplierKey: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_fields_key_uq').on(t.serviceId, t.key),
    check('service_fields_field_type_check', inList(t.fieldType, SERVICE_FIELD_TYPES)),
  ],
);

/** A row read from `service_fields`. */
export type ServiceField = typeof serviceFields.$inferSelect;

/** A row to insert into `service_fields`. */
export type NewServiceField = typeof serviceFields.$inferInsert;

/**
 * Lists of models, providers and MEP values for a service.
 *
 * Why: Model, network and MEP lists a service offers (routes /admin/services/:id/options).
 */
export const serviceOptions = pgTable(
  'service_options',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    list: text().$type<ServiceOptionList>().notNull(),
    value: text().notNull(),
    label: text().notNull(),
    supplierValue: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_options_value_uq').on(t.serviceId, t.list, t.value),
    check('service_options_list_check', inList(t.list, SERVICE_OPTION_LISTS)),
  ],
);

/** A row read from `service_options`. */
export type ServiceOption = typeof serviceOptions.$inferSelect;

/** A row to insert into `service_options`. */
export type NewServiceOption = typeof serviceOptions.$inferInsert;

/**
 * The price of a service per merchant group, including the storefront Retail price.
 *
 * Why: A fixed price of a service for a merchant group, including the storefront retail price (B54).
 */
export const serviceGroupPrices = pgTable(
  'service_group_prices',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    groupId: fk((): AnyPgColumn => clientGroups.id).notNull(),
    price: money().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_group_prices_uq').on(t.serviceId, t.groupId),
    index('service_group_prices_group_id_idx').on(t.groupId),
    check('service_group_prices_price_check', sql`${t.price} >= 0`),
  ],
);

/** A row read from `service_group_prices`. */
export type ServiceGroupPrice = typeof serviceGroupPrices.$inferSelect;

/** A row to insert into `service_group_prices`. */
export type NewServiceGroupPrice = typeof serviceGroupPrices.$inferInsert;

/**
 * A negotiated price of a service for one specific merchant.
 *
 * Why: A negotiated price of a service for one merchant; one per merchant and service (PRICE_EXISTS).
 */
export const serviceClientPrices = pgTable(
  'service_client_prices',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    clientId: fk((): AnyPgColumn => clients.id).notNull(),
    price: money().notNull(),
    note: text().notNull().default(''),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_client_prices_uq').on(t.serviceId, t.clientId),
    index('service_client_prices_client_id_idx').on(t.clientId),
    check('service_client_prices_price_check', sql`${t.price} >= 0`),
    index('service_client_prices_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `service_client_prices`. */
export type ServiceClientPrice = typeof serviceClientPrices.$inferSelect;

/** A row to insert into `service_client_prices`. */
export type NewServiceClientPrice = typeof serviceClientPrices.$inferInsert;

/**
 * Margin and discount rules for automatic pricing.
 *
 * Why: Margin, discount and promo rules for automatic pricing, with a validity window (B19, routes
 * /admin/pricing-rules).
 */
export const pricingRules = pgTable(
  'pricing_rules',
  {
    id: pk(),
    scope: text().$type<PricingScope>().notNull(),
    /** polymorphic: service_categories or services by scope; null for a global rule */
    targetId: bigId(),
    groupId: fk((): AnyPgColumn => clientGroups.id),
    kind: text().$type<PricingRuleKind>().notNull(),
    percent: percent().notNull().default('0'),
    fixed: money().notNull().default('0'),
    rounding: text().$type<PricingRounding>().notNull().default('none'),
    minProfit: money().notNull().default('0'),
    priority: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    /** schema addition B116 */
    startsAt: timestampTz(),
    /** schema addition B116 */
    endsAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('pricing_rules_scope_check', inList(t.scope, PRICING_SCOPES)),
    check('pricing_rules_kind_check', inList(t.kind, PRICING_RULE_KINDS)),
    check('pricing_rules_rounding_check', inList(t.rounding, PRICING_ROUNDINGS)),
    index('pricing_rules_target_idx').on(t.scope, t.targetId),
    index('pricing_rules_priority_idx').on(t.priority),
    check('pricing_rules_target_check', sql`(${t.scope} = 'global') = (${t.targetId} is null)`),
    check(
      'pricing_rules_window_check',
      sql`${t.endsAt} is null or ${t.startsAt} is null or ${t.endsAt} > ${t.startsAt}`,
    ),
    index('pricing_rules_group_id_idx').on(t.groupId),
  ],
);

/** A row read from `pricing_rules`. */
export type PricingRule = typeof pricingRules.$inferSelect;

/** A row to insert into `pricing_rules`. */
export type NewPricingRule = typeof pricingRules.$inferInsert;

/**
 * Stock of digital codes.
 *
 * Why: Stock of digital codes: reserved at placement, sold on completion (decision 025, routes
 * /admin/inventory-codes).
 */
export const inventoryCodes = pgTable(
  'inventory_codes',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id).notNull(),
    /** the code itself, AES-GCM text of decision 019 */
    codeEnc: text().notNull(),
    status: text().$type<InventoryCodeStatus>().notNull().default('available'),
    orderId: fk((): AnyPgColumn => orders.id),
    batchRef: text(),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    /** keyed hash of the code, to detect duplicates on import without decrypting (B18); schema addition B116 */
    codeHash: text().notNull(),
    /** last four characters, so the console can mask the rest (B18); schema addition B116 */
    codeLast4: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('inventory_codes_code_hash_uq')
      .on(t.codeHash)
      .where(sql`${t.status} <> 'void'`),
    check('inventory_codes_status_check', inList(t.status, INVENTORY_CODE_STATUSES)),
    index('inventory_codes_available_idx')
      .on(t.serviceId, t.id)
      .where(sql`${t.status} = 'available'`),
    index('inventory_codes_service_status_idx').on(t.serviceId, t.status),
    index('inventory_codes_created_idx').on(t.createdAt.desc()),
    index('inventory_codes_order_id_idx').on(t.orderId),
    index('inventory_codes_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `inventory_codes`. */
export type InventoryCode = typeof inventoryCodes.$inferSelect;

/** A row to insert into `inventory_codes`. */
export type NewInventoryCode = typeof inventoryCodes.$inferInsert;

/**
 * The first 8 digits of an IMEI (TAC) with brand and model; used for automatic recognition, IMEI checks and SEO
 * pages.
 *
 * Why: Brand and model by TAC (the first 8 IMEI digits): IMEI checks, recognition and SEO pages (routes
 * /admin/tac-catalog).
 */
export const tacCatalog = pgTable(
  'tac_catalog',
  {
    id: pk(),
    /** exactly 8 digits; unique */
    tac: text().notNull(),
    brand: text().notNull(),
    model: text().notNull(),
    marketingName: text().notNull().default(''),
    releaseYear: integer(),
    /** where the entry came from; no source fixes the values */
    source: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tac_catalog_tac_uq').on(t.tac),
    index('tac_catalog_brand_idx').on(t.brand),
    check('tac_catalog_tac_check', sql`${t.tac} ~ '^[0-9]{8}$'`),
  ],
);

/** A row read from `tac_catalog`. */
export type TacCatalogEntry = typeof tacCatalog.$inferSelect;

/** A row to insert into `tac_catalog`. */
export type NewTacCatalogEntry = typeof tacCatalog.$inferInsert;
