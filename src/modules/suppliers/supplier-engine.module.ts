// The supplier engine's services without any route: the supplier client and its limits, the sync, the dispatch and the poll. Loaded by
// the admin routes module and by the worker's job module (the worker never loads the API's route modules).
import { Module } from '@nestjs/common';
import { CatalogPricesModule } from '../catalog';
import { OrdersEngineModule } from '../orders';
import { AuditService, SettingsModule } from '../platform';
import { SupplierClient, SupplierThrottle } from './application/supplier-client';
import { SupplierDispatch } from './application/supplier-dispatch';
import { SupplierPoll } from './application/supplier-poll';
import { SupplierSync } from './application/supplier-sync';

/**
 * Provides {@link SupplierClient}, {@link SupplierThrottle}, {@link SupplierSync}, {@link SupplierDispatch} and {@link SupplierPoll}.
 *
 * Why: decision 016 and 020: the API (the staff's sync, test, fetch and dispatch) and the worker (the jobs) run the same logic, so it
 * lives in one module without controllers. The outbound HTTP, crypto, rate limit, queue and database providers come from the global
 * infrastructure modules both processes load.
 */
@Module({
  imports: [OrdersEngineModule, SettingsModule, CatalogPricesModule],
  providers: [AuditService, SupplierClient, SupplierThrottle, SupplierSync, SupplierDispatch, SupplierPoll],
  exports: [SupplierClient, SupplierThrottle, SupplierSync, SupplierDispatch, SupplierPoll, OrdersEngineModule],
})
export class SupplierEngineModule {}
