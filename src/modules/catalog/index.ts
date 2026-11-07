// Public API of the catalog module: the module, the read-only directory of merchant groups (identity uses it), the effective
// cost function (suppliers use it) and the service figure rules (pricing uses them), then the admin routes module. Other
// modules import only this file.
// Order matters: `CatalogModule` and the leaves other modules use come first, ahead of `CatalogAdminModule`, whose controllers
// lead into identity (decision 032).
export { ClientGroupDirectory, RETAIL_GROUP_KIND } from './application/client-group-directory';
export type { ClientGroupRef, FindGroupOptions } from './application/client-group-directory';
export { recomputeEffectiveCost } from './application/effective-cost';
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
export { CatalogAdminModule } from './catalog-admin.module';
