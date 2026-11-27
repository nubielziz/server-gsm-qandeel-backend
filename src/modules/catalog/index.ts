// Public API of the catalog module: the module, the read-only directory of merchant groups (identity uses it), the effective
// cost function (suppliers use it), the price resolver, the listed-price memory, the merchant catalog and the price guard
// (orders, Dhru and the storefront use them), the storefront's service view and the TAC directory (feature 14a), the price version and the service figure rules,
// the retail price writer, the retail price rules, the follow pass and the pass that cleans category names (feature 31, decision 040), then the admin routes module. Other modules import only this file.
// Order matters: `CatalogModule` and the leaves other modules use come first, ahead of `CatalogAdminModule`, whose controllers
// lead into identity (decision 032), and of the follow pass's worker module, which leads into health.
// The read of the ranks other modules use (an abstract class with no dependencies, so it loads first; decision 064).
export { RankGroupReads } from './ports/rank-group-reads';
export type { ClientGroupKind } from './ports/rank-group-reads';
export {
  CATALOG_CATEGORY_CHANGED_EVENT,
  CATALOG_SERVICES_CHANGED_EVENT,
  CatalogSignals,
  MAX_IDS_PER_EVENT,
  SERVICE_CHANGE_REASONS,
  idChunks,
} from './application/catalog-signals';
export type { ServiceChangeReason } from './application/catalog-signals';
export { ClientGroupDirectory, RETAIL_GROUP_KIND } from './application/client-group-directory';
export type { ClientGroupRef, FindGroupOptions } from './application/client-group-directory';
export { recomputeEffectiveCost } from './application/effective-cost';
export { belowFloorSql } from './infra/service-figures.sql';
export { ServiceImporter } from './application/service-importer';
export type {
  AdoptedField,
  AdoptedService,
  GroupCategory,
  GroupOfService,
  ImportedServiceInput,
} from './application/service-importer';
export { PriceResolver, PricingContext } from './application/price-resolver';
export type { ContextOptions, FloorQuote, PriceRequest } from './application/price-resolver';
export { RetailFloorError, RetailPrices } from './application/retail-prices';
export type {
  LockedService,
  RetailOrigin,
  RetailPriceSource,
  RetailQuote,
  RetailWrite,
} from './application/retail-prices';
export {
  SCOPE_PAGE_SIZE,
  categoryExists,
  importRunExists,
  liveServiceIds,
  ruleLabelsOf,
  serviceIdsOfCategory,
  serviceIdsOfImportRun,
  serviceIdsOfSupplier,
  supplierExists,
  supplyStates,
} from './application/publish-sources';
export type { SupplyState } from './domain/code-stock';
export { RetailPricing, priceWithRules } from './application/retail-pricing';
export type { RetailFacts, RetailFollowState, RetailTarget } from './application/retail-pricing';
export type { RetailRule } from './application/retail-rules';
export {
  DEFAULT_AUTO_FOLLOW_PERCENT,
  costMoved,
  evaluateRetailRule,
  pickRetailRule,
  ruleLabel,
} from './domain/retail-rule';
export type { RetailRuleFigures, RetailRulePrice, RetailRuleQuote } from './domain/retail-rule';
export { ListedPrices } from './application/listed-prices';
export type { ListedPrice, ListedPriceEntry } from './application/listed-prices';
export { MerchantCatalog } from './application/merchant-catalog';
export type { CatalogEntry, CatalogMerchant, CatalogSort } from './application/merchant-catalog';
export { CATALOG_VERSION_NAME, CatalogPriceVersion } from './application/catalog-price-version';
export type { AfterCommitHook } from './application/catalog-price-version';
export {
  applyRounding,
  belowFloorMessage,
  floorFor,
  orderedRules,
  resolveServicePrice,
  ruleMatches,
  ruleMinProfit,
  storefrontFloor,
} from './domain/price-resolution';
export type {
  PriceResolution,
  PriceSource,
  PriceStep,
  PricedGroup,
  PricedService,
  PricingRuleInput,
  ResolveInput,
} from './domain/price-resolution';
export {
  DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT,
  PRICE_CHANGE_TOLERANCE_BOUNDS,
  PRICE_CHANGE_TOLERANCE_KEY,
  checkPriceChange,
} from './domain/price-change';
export type { PriceChangeOptions, PriceChangeVerdict, PriceRaiseReason } from './domain/price-change';
export {
  defaultMinProfit,
  deliveryTimeText,
  dollars,
  effectiveMinProfit,
  floorPrice,
  isBelowFloor,
  marginPercent,
} from './domain/service-figures';
export { IMPORTED_CATEGORY_NAME } from './domain/category-name';
export { INVENTORY_CODE_AAD, inventoryCodeHashInput, lastFour } from './domain/inventory-codes';
export { StorefrontServices } from './application/storefront-services';
export type {
  SellableCategory,
  SellableField,
  SellableFilter,
  SellableService,
  ServiceName,
} from './application/storefront-services';
export { coversSmallestOrder, showsInStock, smallestOrder } from './domain/storefront-availability';
export { MAX_QTY_OPTIONS, MAX_QUANTITY, quantityRuleProblems, resolveQuantityRule } from './domain/quantity-rule';
export type { QuantityRule } from './domain/quantity-rule';
export { InventoryStock } from './application/inventory-stock';
export type { StockClaim } from './application/inventory-stock';
export {
  RETAIL_CHANGE_KINDS,
  RETAIL_CHANGE_REASONS,
  RETAIL_CHANGE_RESOLUTIONS,
  RETAIL_ROUNDINGS,
  RETAIL_RULE_SCOPES,
  SERVICE_DUPLICATE_RULES,
  SERVICE_FIELD_TYPES,
  SERVICE_PRICE_MODES,
  SERVICE_TYPES,
} from './db/schema';
export type {
  RetailChangeKind,
  RetailChangeReason,
  RetailChangeResolution,
  RetailRounding,
  RetailRuleScope,
  ServiceDuplicateRule,
  ServiceFieldType,
  ServicePriceMode,
  ServiceType,
} from './db/schema';
export { CatalogModule } from './catalog.module';
export { CatalogPricesModule } from './catalog-prices.module';
export { PriceVersionListeners } from './application/price-version-listeners';
export type { PriceVersionListener } from './application/price-version-listeners';
export { PriceChangeScan, PRICE_SCAN_JOB } from './application/price-change-scan';
export type { PriceScanResult } from './application/price-change-scan';
export { PriceChangeScanModule } from './jobs/price-change-scan.module';
export {
  RETAIL_FOLLOW_DELAY_MS,
  RETAIL_FOLLOW_JOB,
  RetailFollowScheduler,
} from './application/retail-follow-scheduler';
export { CatalogAdminModule } from './catalog-admin.module';
export { RETAIL_FOLLOW_PAGE, RETAIL_NOTICE_INTERVAL_MS, RetailPriceFollow } from './application/retail-price-follow';
export type { RetailFollowResult } from './application/retail-price-follow';
export { RetailPriceFollowProcessor } from './jobs/retail-price-follow.processor';
export { RETAIL_FOLLOW_SCHEDULER, RetailPriceFollowModule } from './jobs/retail-price-follow.module';
export {
  CATEGORY_NAMES_CLEAN_EVENT,
  CATEGORY_NAMES_CLEAN_JOB,
  CategoryNameCleanup,
} from './application/category-name-cleanup';
export type { CategoryNameCleanupResult } from './application/category-name-cleanup';
export { CategoryNameCleanupModule } from './jobs/category-name-cleanup.module';
export {
  FIELD_PATTERNS_REVIEW_EVENT,
  FIELD_PATTERNS_REVIEW_JOB,
  FIELD_PATTERN_CLEARED_AUDIT_ACTION,
  FieldPatternReview,
} from './application/field-pattern-review';
export type { FieldPatternReviewResult } from './application/field-pattern-review';
export { FieldPatternReviewModule } from './jobs/field-pattern-review.module';
