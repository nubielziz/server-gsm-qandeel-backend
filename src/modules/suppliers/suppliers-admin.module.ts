// The routes and use cases of the suppliers module (stage 6): suppliers, their services and import, the supplier chain of a service, the
// call log and the three order moves that involve a supplier. Separate from SuppliersModule so a test app built without a database can
// leave it out.
import { Module } from '@nestjs/common';
import { OrderSupplierActions } from './application/order-supplier-actions.service';
import { SupplierAdminService } from './application/supplier-admin.service';
import { SupplierCatalogueService } from './application/supplier-catalogue.service';
import { SupplierConnectionService } from './application/supplier-connection.service';
import { SupplierDirectory } from './application/supplier-directory';
import { SupplierLogService } from './application/supplier-log.service';
import { SupplierReader } from './application/supplier-reader';
import { SupplierSyncRequests } from './application/supplier-sync-requests';
import { OrderSupplierController } from './controllers/order-supplier.controller';
import { SupplierLinksLogsController } from './controllers/supplier-links-logs.controller';
import { SuppliersController } from './controllers/suppliers.controller';
import { SupplierEngineModule } from './supplier-engine.module';

/**
 * Provides the `/admin/suppliers*`, `/admin/supplier-api-logs*`, `PUT /admin/services/:id/supplier-links` and the order dispatch, fetch
 * and change-supplier routes.
 *
 * Why: these use cases need the database, the cache (settings, rate limits), the queues (the sync request) and the audit writer,
 * which a database-less test app does not have.
 */
@Module({
  imports: [SupplierEngineModule],
  controllers: [SuppliersController, SupplierLinksLogsController, OrderSupplierController],
  providers: [
    SupplierReader,
    SupplierAdminService,
    SupplierConnectionService,
    SupplierSyncRequests,
    SupplierCatalogueService,
    SupplierLogService,
    OrderSupplierActions,
    SupplierDirectory,
  ],
  exports: [SupplierReader, SupplierDirectory],
})
export class SuppliersAdminModule {}
