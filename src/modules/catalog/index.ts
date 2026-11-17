// Public API of the catalog module: the module, the read-only directory of merchant groups (identity uses it), the effective
// cost function (suppliers use it), the price resolver, the listed-price memory, the merchant catalog and the price guard
// (orders, Dhru, REST v1 and the storefront use them), the storefront's service view and the TAC directory (feature 14a), the price version and the service figure rules, then the admin routes
// module. Other modules import only this file.
// Order matters: `CatalogModule` and the leaves other modules use come first, ahead of `CatalogAdminModule`, whose controllers
// lead into identity (decision 032).
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
export type { AdoptedField, AdoptedService, ImportedServiceInput } from './application/service-importer';
export { PriceResolver, PricingContext } from './application/price-resolver';
export type { ContextOptions, FloorQuote, PriceRequest } from './application/price-resolver';
export { RetailPrices } from './application/retail-prices';
export type { LockedService, RetailQuote } from './application/retail-prices';
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
export { INVENTORY_CODE_AAD, inventoryCodeHashInput, lastFour } from './domain/inventory-codes';
export { StorefrontServices, TacDirectory } from './application/storefront-services';
export type {
  SellableCategory,
  SellableField,
  SellableFilter,
  SellableService,
  ServiceName,
  TacRef,
} from './application/storefront-services';
export { coversSmallestOrder, smallestOrder } from './domain/storefront-availability';
export { MAX_QTY_OPTIONS, MAX_QUANTITY, quantityRuleProblems, resolveQuantityRule } from './domain/quantity-rule';
export type { QuantityRule } from './domain/quantity-rule';
export { InventoryStock } from './application/inventory-stock';
export type { StockClaim } from './application/inventory-stock';
export { SERVICE_DUPLICATE_RULES, SERVICE_PRICE_MODES, SERVICE_TYPES } from './db/schema';
export type { ServiceDuplicateRule, ServicePriceMode, ServiceType } from './db/schema';
export { CatalogModule } from './catalog.module';
export { CatalogPricesModule } from './catalog-prices.module';
export { PriceVersionListeners } from './application/price-version-listeners';
export type { PriceVersionListener } from './application/price-version-listeners';
export { PriceChangeScan, PRICE_SCAN_JOB } from './application/price-change-scan';
export type { PriceScanResult } from './application/price-change-scan';
export { PriceChangeScanModule } from './jobs/price-change-scan.module';
export { CatalogAdminModule } from './catalog-admin.module';
