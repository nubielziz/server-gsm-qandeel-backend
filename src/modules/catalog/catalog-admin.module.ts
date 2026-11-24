// The admin and portal routes of the catalog module (stage 4 and 5): merchant groups, service categories, services with their
// custom fields, option lists and group prices, client prices, pricing rules, the retail price rules (feature 31), the bulk price
// change, the price resolver, the code inventory, the merchant catalog and the retail price changes (feature 31). Separate from CatalogModule so a test app built without a database can leave it out while
// ClientGroupDirectory and the resolver stay available.
import { Module } from '@nestjs/common';
import { BulkPriceAdminService } from './application/bulk-price-admin.service';
import { CategoryAdminService } from './application/category-admin.service';
import { ClientCatalogService } from './application/client-catalog.service';
import { ClientGroupAdminService } from './application/client-group-admin.service';
import { ClientPriceAdminService } from './application/client-price-admin.service';
import { GroupPriceAdminService } from './application/group-price-admin.service';
import { InventoryAdminService } from './application/inventory-admin.service';
import { MerchantApiCatalog } from './application/merchant-api-catalog';
import { PricingResolveService } from './application/pricing-resolve.service';
import { PricingRuleAdminService } from './application/pricing-rule-admin.service';
import { RetailFollowSteps } from './application/retail-follow-steps';
import { RetailPriceChangesService } from './application/retail-price-changes.service';
import { RetailPriceRuleAdminService } from './application/retail-price-rule-admin.service';
import { ServiceAdminService } from './application/service-admin.service';
import { ServiceOrderService } from './application/service-order.service';
import { ServicePartsService } from './application/service-parts.service';
import { ServicePriceGridService } from './application/service-price-grid.service';
import { CategoriesController } from './controllers/categories.controller';
import { ClientCatalogController } from './controllers/client-catalog.controller';
import { ClientGroupsController } from './controllers/client-groups.controller';
import { ClientPricesController } from './controllers/client-prices.controller';
import { InventoryController } from './controllers/inventory.controller';
import { PricingController } from './controllers/pricing.controller';
import { PricingRulesController } from './controllers/pricing-rules.controller';
import { RetailPriceChangesController } from './controllers/retail-price-changes.controller';
import { RetailPriceRulesController } from './controllers/retail-price-rules.controller';
import { ServiceGridController } from './controllers/service-grid.controller';
import { ServicesController } from './controllers/services.controller';

/**
 * Provides `/admin/client-groups`, `/admin/service-categories`, `/admin/services` (with `fields`, `options`, `group-prices`,
 * `bulk-price`, `price-grid` and `order`), `/admin/client-prices`, `/admin/pricing-rules`, `/admin/retail-price-rules` (with `preview`),
 * `/admin/retail-price-changes` (with `resolve`), `/admin/pricing/resolve`, `/admin/inventory-codes`,
 * `/admin/services/:id/inventory/import`, the portal's `/client/services` and `/client/prices/export`, and the merchant's catalog over
 * Dhru (`imeiservicelist`).
 *
 * Why: these use cases need the global database, audit, crypto, cache and clock providers, merchant counts from identity and credit
 * limits from money, which a database-less test app does not have; `ClientGroupDirectory` and the resolver (the global
 * `CatalogModule`) need none of them.
 */
@Module({
  controllers: [
    ClientGroupsController,
    CategoriesController,
    ServicesController,
    ServiceGridController,
    PricingController,
    ClientPricesController,
    PricingRulesController,
    RetailPriceRulesController,
    RetailPriceChangesController,
    InventoryController,
    ClientCatalogController,
  ],
  providers: [
    ClientGroupAdminService,
    CategoryAdminService,
    ServiceAdminService,
    ServicePriceGridService,
    ServiceOrderService,
    ServicePartsService,
    GroupPriceAdminService,
    ClientPriceAdminService,
    PricingRuleAdminService,
    RetailPriceRuleAdminService,
    RetailFollowSteps,
    RetailPriceChangesService,
    BulkPriceAdminService,
    PricingResolveService,
    ClientCatalogService,
    MerchantApiCatalog,
    InventoryAdminService,
  ],
})
export class CatalogAdminModule {}
