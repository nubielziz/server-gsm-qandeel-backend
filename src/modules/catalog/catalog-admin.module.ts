// The admin routes of the catalog module (stage 4 and 5, structure): merchant groups, service categories, services with their
// custom fields and option lists, and the code inventory. Separate from CatalogModule so a test app built without a database can
// leave it out while ClientGroupDirectory stays available.
import { Module } from '@nestjs/common';
import { CategoryAdminService } from './application/category-admin.service';
import { ClientGroupAdminService } from './application/client-group-admin.service';
import { InventoryAdminService } from './application/inventory-admin.service';
import { ServiceAdminService } from './application/service-admin.service';
import { ServicePartsService } from './application/service-parts.service';
import { CategoriesController } from './controllers/categories.controller';
import { ClientGroupsController } from './controllers/client-groups.controller';
import { InventoryController } from './controllers/inventory.controller';
import { ServicesController } from './controllers/services.controller';

/**
 * Provides `/admin/client-groups`, `/admin/service-categories`, `/admin/services` (with `fields` and `options`),
 * `/admin/inventory-codes` and `/admin/services/:id/inventory/import`.
 *
 * Why: these use cases need the global database, audit, crypto and clock providers, merchant counts from identity and credit
 * limits from money, which a database-less test app does not have; `ClientGroupDirectory` (the global `CatalogModule`) needs
 * none of them.
 */
@Module({
  controllers: [ClientGroupsController, CategoriesController, ServicesController, InventoryController],
  providers: [
    ClientGroupAdminService,
    CategoryAdminService,
    ServiceAdminService,
    ServicePartsService,
    InventoryAdminService,
  ],
})
export class CatalogAdminModule {}
