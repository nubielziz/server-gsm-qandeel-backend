// Catalog & pricing module (map domain B): groups, categories, services, fields, prices, pricing rules, inventory, TAC.
// It provides the read-only ClientGroupDirectory and the price resolver, the listed-price memory and the merchant catalog (none
// of them holds a connection: they take the caller's database handle); the admin routes of the catalog are CatalogAdminModule
// (docs/ARCHITECTURE.md § 2).
import { Global, Module } from '@nestjs/common';
import { CatalogSignals } from './application/catalog-signals';
import { ClientGroupDirectory } from './application/client-group-directory';
import { ListedPrices } from './application/listed-prices';
import { InventoryStock } from './application/inventory-stock';
import { MerchantCatalog } from './application/merchant-catalog';
import { PriceResolver } from './application/price-resolver';
import { RetailPrices } from './application/retail-prices';
import { RetailPricing } from './application/retail-pricing';
import { StorefrontServices } from './application/storefront-services';
import { ServiceImporter } from './application/service-importer';
import { RankGroupReads } from './ports/rank-group-reads';

/**
 * Nest module for Catalog & pricing (map domain B).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). It is global so identity (merchant creation, group moves) can inject the directory, and
 * orders, the Dhru list and the storefront can inject the resolver, the listed prices, the merchant catalog and the
 * code stock, without importing the module. Everything here needs only the clock and the encryption service (both global
 * infrastructure) and a database handle passed by the caller; the admin routes are `CatalogAdminModule`, which the root module imports
 * next to this one. No module of identity names `CatalogModule` in its decorator: the catalog's index leads back into identity (the rank
 * kind rule the service importer's reads use, and money's services behind the group admin), so such a decorator could read the class
 * before it is initialised (decision 032); being global, its exports reach identity anyway.
 *
 * Port binding (decision 064): `RankGroupReads` is `ClientGroupDirectory`. The account directory, the rank writer, the session core's
 * rank kinds, the API key directory, the staff account routes, the rank change and the support inbox read a rank's kind, name and order
 * through it, in both processes (the worker loads this module through the catalog's job modules).
 */
@Global()
@Module({
  providers: [
    CatalogSignals,
    ClientGroupDirectory,
    PriceResolver,
    RetailPrices,
    RetailPricing,
    ListedPrices,
    MerchantCatalog,
    ServiceImporter,
    InventoryStock,
    StorefrontServices,
    { provide: RankGroupReads, useExisting: ClientGroupDirectory },
  ],
  exports: [
    CatalogSignals,
    ClientGroupDirectory,
    PriceResolver,
    RetailPrices,
    RetailPricing,
    ListedPrices,
    MerchantCatalog,
    ServiceImporter,
    InventoryStock,
    StorefrontServices,
    RankGroupReads,
  ],
})
export class CatalogModule {}
