// Catalog tables (map domain B): groups, services and their fields, options and prices, rules, codes, TAC list.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSequence,
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
 * How a service is priced: a fixed base price (the only mode today).
 *
 * Why: RESOLUTIONS catalog-2: the console form has no pricing-mode field, so `fixed` is the one value; a new mode needs
 * a migration.
 */
export const SERVICE_PRICE_MODES = ['fixed'] as const;

/** One value of {@link SERVICE_PRICE_MODES}. */
export type ServicePriceMode = (typeof SERVICE_PRICE_MODES)[number];

/**
 * What happens when a merchant orders the same IMEI twice: `allow` it, or `block_open` while the first order is open.
 *
 * Why: RESOLUTIONS catalog-2 and the map's duplicate-order rule (error DUPLICATE_ORDER).
 */
export const SERVICE_DUPLICATE_RULES = ['allow', 'block_open'] as const;

/** One value of {@link SERVICE_DUPLICATE_RULES}. */
export type ServiceDuplicateRule = (typeof SERVICE_DUPLICATE_RULES)[number];

/**
 * Input types of a custom service field.
 *
 * Why: the console's service field wire enum (PUT /admin/services/:id/fields), a wire fact the console and the shop copy in this order.
 * Decision 073 adds `imei`: the field holds one IMEI (read as digits, 15 with a valid Luhn check digit), on any service type; it is the
 * default main input of an IMEI service. Decision 076 adds ten check types (`imei_bulk`: a list of 1 to 30 IMEIs, one order at one price;
 * `imeisv`, `serial`, `iccid`, `eid`, `meid`, `ecid`, `mac_address`, `mi_lock_code`, `box_sn`); placement reads and judges each by
 * the orders module's `FIELD_TYPE_RULES`.
 */
export const SERVICE_FIELD_TYPES = [
  'text',
  'number',
  'select',
  'textarea',
  'imei',
  'imei_bulk',
  'imeisv',
  'serial',
  'iccid',
  'eid',
  'meid',
  'ecid',
  'mac_address',
  'mi_lock_code',
  'box_sn',
] as const;

/** One value of {@link SERVICE_FIELD_TYPES}. */
export type ServiceFieldType = (typeof SERVICE_FIELD_TYPES)[number];

/**
 * Which list a service option belongs to.
 *
 * Why: the console's service option wire enum (the `options` of `GET /admin/services/:id`; the write route `PUT
 * /admin/services/:id/options` is retired, decision 072).
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
 * What a retail price rule covers: every service, one service type, or one category.
 *
 * Why: decision 040 (feature 31): the most specific active rule prices a service (category, then type, then global).
 */
export const RETAIL_RULE_SCOPES = ['global', 'type', 'category'] as const;

/** One value of {@link RETAIL_RULE_SCOPES}. */
export type RetailRuleScope = (typeof RETAIL_RULE_SCOPES)[number];

/**
 * How a retail price rule rounds its price, always upwards: to the cent, to the next 0.05 or 0.10, or to the next `n.99`.
 *
 * Why: decision 040 and plan 31 section 3.3: the shop charges whole cents rounded up, so a rule never rounds down (the trap of
 * `applyRounding`'s `ends_99`, which can).
 */
export const RETAIL_ROUNDINGS = ['cent', 'step_0.05', 'step_0.10', 'ends_99'] as const;

/** One value of {@link RETAIL_ROUNDINGS}. */
export type RetailRounding = (typeof RETAIL_ROUNDINGS)[number];

/**
 * What the follow pass did about a following retail price: moved it, proposed a move for staff, or found it changed elsewhere.
 *
 * Why: decision 040 and plan 31 section 3.4: every automatic change and every proposal is a row staff can read.
 */
export const RETAIL_CHANGE_KINDS = ['followed', 'proposed', 'detached'] as const;

/** One value of {@link RETAIL_CHANGE_KINDS}. */
export type RetailChangeKind = (typeof RETAIL_CHANGE_KINDS)[number];

/**
 * Why a following retail price moved, waits or stopped following.
 *
 * Why: plan 31 section 3.4: `cost_changed`, `rule_changed` and `floor_changed` name what moved a price (`rule_changed` also names a
 * proposal for a service that moved to another rule by itself), `cost_jump` and `no_cost` a proposal, `changed_elsewhere` a detach.
 */
export const RETAIL_CHANGE_REASONS = [
  'cost_changed',
  'rule_changed',
  'floor_changed',
  'cost_jump',
  'no_cost',
  'changed_elsewhere',
] as const;

/** One value of {@link RETAIL_CHANGE_REASONS}. */
export type RetailChangeReason = (typeof RETAIL_CHANGE_REASONS)[number];

/**
 * How a proposal was closed: staff applied it, staff kept the price, or the system found it no longer applies.
 *
 * Why: plan 31 sections 3.4 and 5.4.
 */
export const RETAIL_CHANGE_RESOLUTIONS = ['applied', 'kept', 'superseded'] as const;

/** One value of {@link RETAIL_CHANGE_RESOLUTIONS}. */
export type RetailChangeResolution = (typeof RETAIL_CHANGE_RESOLUTIONS)[number];

/**
 * Life of a stocked code: reserved at placement, sold on completion, released on rejection; `void` is withdrawn.
 *
 * Why: decision 025 and the console's inventory wire enum (GET /admin/inventory-codes).
 */
export const INVENTORY_CODE_STATUSES = ['available', 'reserved', 'sold', 'void'] as const;

/** One value of {@link INVENTORY_CODE_STATUSES}. */
export type InventoryCodeStatus = (typeof INVENTORY_CODE_STATUSES)[number];

/**
 * The kinds of rank: `b2b` is a merchant rank, `b2c_retail` is the one retail rank.
 *
 * Why: decision 064: the kind of a rank decides what its accounts may do (`rankKindOf`: only `b2b` is a merchant, anything else has retail
 * rights), so the list is closed. The wire says `merchant` and `retail`; the stored words stay.
 */
export const CLIENT_GROUP_KINDS = ['b2b', 'b2c_retail'] as const;

/** One value of {@link CLIENT_GROUP_KINDS}. */
export type ClientGroupKind = (typeof CLIENT_GROUP_KINDS)[number];

/**
 * The ranks of accounts (the table keeps its old name `client_groups`) with their discount percentages and promotion limits;
 * kind = b2c_retail marks the single retail rank used by the storefront and by every guest.
 *
 * Why: Merchant tiers with discounts and limits, plus the single storefront retail rank (routes /admin/client-groups). Decision 064: the
 * rank is the one thing that tells a merchant from a retail account.
 */
export const clientGroups = pgTable(
  'client_groups',
  {
    id: pk(),
    name: text().notNull(),
    /** see {@link CLIENT_GROUP_KINDS}; `b2c_retail` marks the storefront's single retail rank */
    kind: text().$type<ClientGroupKind>().notNull().default('b2b'),
    discountPercent: percent().notNull().default('0'),
    isDefault: boolean().notNull().default(false),
    /** Retired (decision 062): ranks are set by hand, nothing reads or writes the upgrade threshold; the accounts migration drops it. */
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
    check('client_groups_kind_check', inList(t.kind, CLIENT_GROUP_KINDS)),
    // The retail rank never has credit (the ranks admin refuses it too).
    check('client_groups_retail_no_credit_check', sql`${t.kind} <> 'b2c_retail' or not ${t.overdraftAllowed}`),
    check(
      'client_groups_amounts_check',
      sql`${t.earnThreshold} >= 0 and ${t.depositLimit} >= 0 and ${t.discountPercent} >= 0 and ${t.discountPercent} <= 100`,
    ),
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
    // The target of the composite foreign key that keeps a service's type equal to its category's (services).
    unique('service_categories_id_type_uq').on(t.id, t.type),
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
    /** with `type`, a composite foreign key to `service_categories (id, type)` (declared below) */
    categoryId: bigId().notNull(),
    /** always the type of the category (RESOLUTIONS catalog-13) */
    type: text().$type<ServiceType>().notNull(),
    name: text().notNull(),
    info: text().notNull().default(''),
    /** display text; derived from sla_minutes by the writer */
    deliveryTime: text().notNull().default(''),
    status: text().$type<ServiceStatus>().notNull().default('active'),
    fulfillment: text().$type<FulfillmentMode>().notNull(),
    priceMode: text().$type<ServicePriceMode>().notNull().default('fixed'),
    /** the price of the default group, always above zero (RESOLUTIONS catalog-9) */
    basePrice: money().notNull(),
    /**
     * the service's own cost (decision 069: staff set it as `ownCost`; a supplier import writes the supplier's cost here); the
     * effective cost never falls under it
     */
    cost: money().notNull().default('0'),
    /**
     * the floor of every price: the larger of the service cost and the latest synced supplier cost of its first
     * active link (RESOLUTIONS catalog-1, decision 9 of the user rules); refreshed by the price sync
     */
    effectiveCost: money().notNull().default('0'),
    costCurrency: text().notNull().default('USD'),
    minQty: integer().notNull().default(1),
    maxQty: integer().notNull().default(1),
    qtyOptions: intList(),
    allowFree: boolean().notNull().default(false),
    duplicateRule: text().$type<ServiceDuplicateRule>().notNull().default('block_open'),
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
    /**
     * the position staff gave the service among the services of its category, 0 when never set (decision 063); what merchants and
     * API clients read is ordered by the category's position, then this, then the name
     */
    sort: integer().notNull().default(0),
    /**
     * the service is delivered from code stock (decision 069): only such a service holds inventory codes, and only its orders take
     * codes from the stock at placement; turned off only when no code is available. A column beyond the map (migration 0070).
     */
    stockDelivery: boolean().notNull().default(false),
    /** set when staff delete a service that orders already use; an archived service is disabled (RESOLUTIONS catalog-3) */
    archivedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // An archived service gives its code back for a new service.
    uniqueIndex('services_code_uq')
      .on(lower(t.code))
      .where(sql`${t.archivedAt} is null`),
    check('services_type_check', inList(t.type, SERVICE_TYPES)),
    check('services_status_check', inList(t.status, SERVICE_STATUSES)),
    check('services_fulfillment_check', inList(t.fulfillment, FULFILLMENT_MODES)),
    check('services_price_mode_check', inList(t.priceMode, SERVICE_PRICE_MODES)),
    check('services_duplicate_rule_check', inList(t.duplicateRule, SERVICE_DUPLICATE_RULES)),
    index('services_type_status_idx').on(t.type, t.status),
    index('services_live_type_status_idx')
      .on(t.type, t.status)
      .where(sql`${t.archivedAt} is null`),
    check('services_qty_check', sql`${t.minQty} >= 1 and ${t.maxQty} >= ${t.minQty}`),
    // Feature 25: the limits of the quantity rule. Order, uniqueness and "min/max equal the smallest/largest pack" are the
    // domain rule's (domain/quantity-rule.ts); readers stay defensive about them.
    check(
      'services_qty_limits_check',
      sql`${t.maxQty} <= 100000 and cardinality(${t.qtyOptions}) <= 50 and array_position(${t.qtyOptions}, null) is null and 1 <= all (${t.qtyOptions}) and 100000 >= all (${t.qtyOptions})`,
    ),
    check('services_prices_check', sql`${t.cost} >= 0 and ${t.basePrice} > 0`),
    check('services_effective_cost_check', sql`${t.effectiveCost} >= ${t.cost}`),
    check('services_archived_check', sql`${t.archivedAt} is null or ${t.status} = 'disabled'`),
    check('services_sla_check', sql`${t.slaMinutes} > 0`),
    check('services_sort_check', sql`${t.sort} >= 0 and ${t.sort} <= 1000000`),
    foreignKey({
      name: 'services_category_type_fk',
      columns: [t.categoryId, t.type],
      foreignColumns: [serviceCategories.id, serviceCategories.type],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    // Leads with category_id and carries the type too, so it also serves the composite foreign key above.
    index('services_category_type_idx').on(t.categoryId, t.type),
    index('services_effective_cost_idx').on(t.effectiveCost),
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
    /**
     * The field's Name (decision 065): never empty, unique in its service ignoring case, and what a supplier receives in
     * CUSTOMFIELD. The SQL column keeps the map's name.
     */
    supplierKey: text().notNull(),
    /**
     * The field is the service's main input (decision 065): its value travels as the IMEI parameter, never in CUSTOMFIELD. At most
     * one per service. A column beyond the map (migration 0068).
     */
    isMainInput: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_fields_key_uq').on(t.serviceId, t.key),
    uniqueIndex('service_fields_name_uq').on(t.serviceId, lower(t.supplierKey)),
    uniqueIndex('service_fields_main_input_uq')
      .on(t.serviceId)
      .where(sql`${t.isMainInput}`),
    check('service_fields_field_type_check', inList(t.fieldType, SERVICE_FIELD_TYPES)),
    check('service_fields_supplier_key_check', sql`btrim(${t.supplierKey}) <> ''`),
  ],
);

/** A row read from `service_fields`. */
export type ServiceField = typeof serviceFields.$inferSelect;

/** A row to insert into `service_fields`. */
export type NewServiceField = typeof serviceFields.$inferInsert;

/**
 * Lists of models, providers and MEP values for a service.
 *
 * Why: Model, network and MEP lists a service offers. Read only since decision 072 retired `PUT /admin/services/:id/options` (the rows
 * are read by `GET /admin/services/:id`, `GET /client/services/:id`, the shop's reference lists and the search labels; the table stays
 * because the map is read-only, and production holds no rows).
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
 * Retail price rules: the shop's price as the effective cost plus a percent and a fixed amount, rounded up, never under the
 * storefront floor (feature 31, a table beyond the map).
 *
 * Why: decision 040: a store of their own, not rows of the B2B `pricing_rules` (those adjust the base price for merchants and
 * never read the cost). At most one rule per target among the rules that are not deleted. A delete is soft (`deleted_at`): the
 * history keeps the rule's name, and a delete never waits on, or deadlocks with, a transaction whose foreign key check reads the
 * rule row (plan 31 section 4.1). Every read of the rules filters `deleted_at IS NULL`, except the label of history rows.
 */
export const retailPriceRules = pgTable(
  'retail_price_rules',
  {
    id: pk(),
    scope: text().$type<RetailRuleScope>().notNull(),
    /** the target of a `type` rule; null otherwise */
    serviceType: text().$type<ServiceType>(),
    /** the target of a `category` rule; null otherwise. A category delete (only of a category with no service) removes it */
    categoryId: fk((): AnyPgColumn => serviceCategories.id, 'cascade'),
    /** percent units with four decimals: `30.0000` is +30 % */
    percent: percent().notNull(),
    fixed: money().notNull().default('0'),
    rounding: text().$type<RetailRounding>().notNull(),
    /** the rounding style applies only to a price of at least this much; under it the price is the cent */
    roundFrom: money().notNull().default('5'),
    /** the largest move of the cost, in percent, that a following price follows by itself; 0 makes every move wait */
    autoFollowPercent: integer().notNull().default(25),
    isActive: boolean().notNull().default(true),
    updatedBy: fk((): AnyPgColumn => staffUsers.id),
    /** the clock's time of the create and of every edit (the follow pass names its reason from it); never `updated_at` */
    changedAt: timestampTz().notNull(),
    /** set by the soft delete; a deleted rule is inactive and counts nowhere */
    deletedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('retail_price_rules_scope_check', inList(t.scope, RETAIL_RULE_SCOPES)),
    check('retail_price_rules_service_type_check', inList(t.serviceType, SERVICE_TYPES)),
    check('retail_price_rules_rounding_check', inList(t.rounding, RETAIL_ROUNDINGS)),
    check(
      'retail_price_rules_target_check',
      sql`(${t.scope} = 'global' and ${t.serviceType} is null and ${t.categoryId} is null) or (${t.scope} = 'type' and ${t.serviceType} is not null and ${t.categoryId} is null) or (${t.scope} = 'category' and ${t.serviceType} is null and ${t.categoryId} is not null)`,
    ),
    check('retail_price_rules_percent_check', sql`${t.percent} >= 0 and ${t.percent} <= 1000`),
    check('retail_price_rules_fixed_check', sql`${t.fixed} >= 0 and ${t.fixed} <= 100000`),
    check('retail_price_rules_round_from_check', sql`${t.roundFrom} >= 0`),
    check('retail_price_rules_auto_follow_check', sql`${t.autoFollowPercent} >= 0 and ${t.autoFollowPercent} <= 1000`),
    check('retail_price_rules_deleted_check', sql`${t.deletedAt} is null or ${t.isActive} = false`),
    // One rule per target among the rules not deleted (active or not); a deleted rule leaves its target free.
    uniqueIndex('retail_price_rules_global_uq')
      .on(t.scope)
      .where(sql`${t.scope} = 'global' and ${t.deletedAt} is null`),
    uniqueIndex('retail_price_rules_type_uq')
      .on(t.serviceType)
      .where(sql`${t.scope} = 'type' and ${t.deletedAt} is null`),
    uniqueIndex('retail_price_rules_category_uq')
      .on(t.categoryId)
      .where(sql`${t.scope} = 'category' and ${t.deletedAt} is null`),
    // The three unique indexes are partial, so the foreign key needs a full index of its own.
    index('retail_price_rules_category_idx').on(t.categoryId),
    index('retail_price_rules_updated_by_idx').on(t.updatedBy),
  ],
);

/** A row read from `retail_price_rules`. */
export type RetailPriceRule = typeof retailPriceRules.$inferSelect;

/** A row to insert into `retail_price_rules`. */
export type NewRetailPriceRule = typeof retailPriceRules.$inferInsert;

/**
 * The services whose retail price follows the rules: a row means "a rule wrote this price last" (feature 31, a table beyond
 * the map).
 *
 * Why: decision 040: a price is typed (no row) or following (a row). `RetailPrices.set` keeps the row in step (a typed price
 * deletes it, a rule price upserts it) and the group price page deletes it when it changes or removes the retail row, so a rule
 * never overwrites a price a person typed. `applied_price` and `applied_cost` are what the follow pass compares with.
 */
export const retailPriceFollows = pgTable(
  'retail_price_follows',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    /** the rule that priced the service last; a hard delete (the cascade of a category delete) sets it to null */
    ruleId: bigId().references((): AnyPgColumn => retailPriceRules.id, { onDelete: 'set null' }),
    /** the price a rule wrote last */
    appliedPrice: money().notNull(),
    /** the effective cost that price was worked out from */
    appliedCost: money().notNull(),
    appliedAt: timestampTz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('retail_price_follows_service_uq').on(t.serviceId),
    index('retail_price_follows_rule_idx').on(t.ruleId),
    check('retail_price_follows_applied_price_check', sql`${t.appliedPrice} > 0`),
    check('retail_price_follows_applied_cost_check', sql`${t.appliedCost} >= 0`),
  ],
);

/** A row read from `retail_price_follows`. */
export type RetailPriceFollow = typeof retailPriceFollows.$inferSelect;

/** A row to insert into `retail_price_follows`. */
export type NewRetailPriceFollow = typeof retailPriceFollows.$inferInsert;

/**
 * What the follow pass did or proposes for following retail prices: the console's "Price changes" (feature 31, a table beyond the
 * map).
 *
 * Why: decision 040 and plan 31 section 3.4: a following price moves without a staff action, so every move, every proposal and every
 * price found changed elsewhere is a row staff can read and resolve. One proposal waits per service at most; `notified_at` is what
 * keeps the hourly message from repeating a row.
 */
export const retailPriceChanges = pgTable(
  'retail_price_changes',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    /** the rule that prices the service; a hard delete (the cascade of a category delete) sets it to null */
    ruleId: bigId().references((): AnyPgColumn => retailPriceRules.id, { onDelete: 'set null' }),
    kind: text().$type<RetailChangeKind>().notNull(),
    reason: text().$type<RetailChangeReason>().notNull(),
    /** the price before the move: for a detached price, the price the rule wrote last */
    oldPrice: money().notNull(),
    /** the price written or proposed; null for `no_cost` and for `detached` */
    newPrice: money(),
    /** the effective cost the old price was worked out from */
    oldCost: money().notNull(),
    /** the effective cost of the pass */
    newCost: money().notNull(),
    /** how a proposal was closed; null while it waits, and on every row that is not a proposal */
    resolution: text().$type<RetailChangeResolution>(),
    resolvedAt: timestampTz(),
    /** the staff member who resolved it; null when the system closed it */
    resolvedBy: fk((): AnyPgColumn => staffUsers.id),
    /** set by the hourly message; a rewrite of a waiting proposal keeps it */
    notifiedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('retail_price_changes_kind_check', inList(t.kind, RETAIL_CHANGE_KINDS)),
    check('retail_price_changes_reason_check', inList(t.reason, RETAIL_CHANGE_REASONS)),
    check('retail_price_changes_resolution_value_check', inList(t.resolution, RETAIL_CHANGE_RESOLUTIONS)),
    check(
      'retail_price_changes_resolution_check',
      sql`(${t.resolution} is null) = (${t.resolvedAt} is null) and (${t.resolution} is null or ${t.kind} = 'proposed')`,
    ),
    // One waiting proposal per service.
    uniqueIndex('retail_price_changes_open_uq')
      .on(t.serviceId)
      .where(sql`${t.kind} = 'proposed' and ${t.resolvedAt} is null`),
    index('retail_price_changes_kind_idx').on(t.kind, t.resolvedAt),
    index('retail_price_changes_service_idx').on(t.serviceId),
    index('retail_price_changes_rule_idx').on(t.ruleId),
    index('retail_price_changes_resolved_by_idx').on(t.resolvedBy),
    // What the hourly message has not reported yet.
    index('retail_price_changes_unnotified_idx')
      .on(t.id)
      .where(sql`${t.notifiedAt} is null`),
  ],
);

/** A row read from `retail_price_changes`. */
export type RetailPriceChange = typeof retailPriceChanges.$inferSelect;

/** A row to insert into `retail_price_changes`. */
export type NewRetailPriceChange = typeof retailPriceChanges.$inferInsert;

/**
 * The last price listed to a merchant for a service (the price-protection memory of user rule 9).
 *
 * Why: MISMATCHES B117 (4), a backend addition to the map's tables: every list a merchant reads (the portal catalog and price
 * export, Dhru list) records the price it showed; an order more than `pricing.price_change_tolerance_percent`
 * above it is refused with `409 PRICE_CHANGED`. A row is written only when the price changes, so `listed_at` is the time the
 * merchant was first shown the current price.
 */
export const listedPrices = pgTable(
  'listed_prices',
  {
    id: pk(),
    clientId: fk((): AnyPgColumn => clients.id, 'cascade').notNull(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    price: money().notNull(),
    /** the currency the price was listed in; USD today */
    currency: text().notNull().default('USD'),
    /** when this price was first listed to the merchant */
    listedAt: timestampTz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('listed_prices_uq').on(t.clientId, t.serviceId),
    index('listed_prices_service_id_idx').on(t.serviceId),
    check('listed_prices_price_check', sql`${t.price} >= 0`),
    check('listed_prices_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** A row read from `listed_prices`. */
export type ListedPriceRow = typeof listedPrices.$inferSelect;

/** A row to insert into `listed_prices`. */
export type NewListedPriceRow = typeof listedPrices.$inferInsert;

/**
 * Numbers the import batches of inventory codes: `B-0001`, `B-0002`, ...
 *
 * Why: RESOLUTIONS catalog-15: every imported code carries the reference of its batch, drawn from one sequence so
 * two concurrent imports never share one (POST /admin/services/:id/inventory/import).
 */
export const inventoryBatchRefSeq = pgSequence('inventory_batch_ref_seq');

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
    /** `B-0001`-style reference of the import batch, from {@link inventoryBatchRefSeq}; never empty */
    batchRef: text().notNull(),
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
    check('inventory_codes_batch_ref_check', sql`${t.batchRef} <> ''`),
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
 * The first 8 digits of an IMEI (TAC) with brand and model; used for automatic recognition and SEO pages.
 *
 * Why: Brand and model by TAC (the first 8 IMEI digits): recognition and SEO pages (routes /admin/tac-catalog).
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
