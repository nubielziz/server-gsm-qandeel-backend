// Catalog & pricing module (map domain B): groups, categories, services, fields, prices, pricing rules, inventory, TAC.
// It provides the read-only ClientGroupDirectory and the price resolver, the listed-price memory and the merchant catalog (none
// of them holds a connection: they take the caller's database handle); the admin routes of the catalog are CatalogAdminModule
// (docs/ARCHITECTURE.md § 2).
import { Global, Module } from '@nestjs/common';
import { ClientGroupDirectory } from './application/client-group-directory';
import { ListedPrices } from './application/listed-prices';
import { InventoryStock } from './application/inventory-stock';
import { MerchantCatalog } from './application/merchant-catalog';
import { PriceResolver } from './application/price-resolver';
import { RetailPrices } from './application/retail-prices';
import { StorefrontServices, TacDirectory } from './application/storefront-services';
import { ServiceImporter } from './application/service-importer';

/**
 * Nest module for Catalog & pricing (map domain B).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). It is global so identity (merchant creation, group moves, the promotion job) can inject the directory, and
 * orders, the Dhru and REST v1 lists and the storefront can inject the resolver, the listed prices, the merchant catalog and the
 * code stock, without importing the module. Everything here needs only the clock and the encryption service (both global
 * infrastructure) and a database handle passed by the caller, so
 * the module imports nothing that leads back into identity (the admin routes are `CatalogAdminModule`, which the root module
 * imports next to this one), and identity can import `CatalogModule` while it is still loading (decision 032).
 */
@Global()
@Module({
  providers: [
    ClientGroupDirectory,
    PriceResolver,
    RetailPrices,
    ListedPrices,
    MerchantCatalog,
    ServiceImporter,
    InventoryStock,
    StorefrontServices,
    TacDirectory,
  ],
  exports: [
    ClientGroupDirectory,
    PriceResolver,
    RetailPrices,
    ListedPrices,
    MerchantCatalog,
    ServiceImporter,
    InventoryStock,
    StorefrontServices,
    TacDirectory,
  ],
})
export class CatalogModule {}
