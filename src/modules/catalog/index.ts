// Public API of the catalog module: the module, the read-only directory of merchant groups (identity uses it), the effective
// cost function (suppliers use it), the price resolver, the listed-price memory, the merchant catalog and the price guard
// (orders, Dhru, REST v1 and the storefront use them), the price version and the service figure rules, then the admin routes
// module. Other modules import only this file.
// Order matters: `CatalogModule` and the leaves other modules use come first, ahead of `CatalogAdminModule`, whose controllers
// lead into identity (decision 032).
export { ClientGroupDirectory, RETAIL_GROUP_KIND } from './application/client-group-directory';
export type { ClientGroupRef, FindGroupOptions } from './application/client-group-directory';
export { recomputeEffectiveCost } from './application/effective-cost';
export { PriceResolver, PricingContext } from './application/price-resolver';
export type { ContextOptions, FloorQuote, PriceRequest } from './application/price-resolver';
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
  effectiveMinProfit,
  floorPrice,
  isBelowFloor,
  marginPercent,
} from './domain/service-figures';
export { INVENTORY_CODE_AAD, inventoryCodeHashInput, lastFour } from './domain/inventory-codes';
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
