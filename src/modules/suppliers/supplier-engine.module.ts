// The supplier engine's services without any route: the supplier client and its limits, the sync, the dispatch and the poll. Loaded by
// the admin routes module and by the worker's job module (the worker never loads the API's route modules).
import { Module } from '@nestjs/common';
import { CatalogPricesModule, CatalogSignals, ServiceImporter } from '../catalog';
import { OrdersEngineModule } from '../orders';
import { AuditService, SettingsModule } from '../platform';
import { QuickAddOutbox } from './application/quick-add-outbox';
import { QuickAddRunner } from './application/quick-add-runner';
import { SupplierClient, SupplierThrottle } from './application/supplier-client';
import { SupplierDispatch } from './application/supplier-dispatch';
import { SupplierPoll } from './application/supplier-poll';
import { SupplierSync } from './application/supplier-sync';

/**
 * Provides {@link SupplierClient}, {@link SupplierThrottle}, {@link SupplierSync}, {@link SupplierDispatch}, {@link SupplierPoll},
 * {@link QuickAddRunner} and {@link QuickAddOutbox}.
 *
 * Why: decision 016 and 020: the API (the staff's sync, test, fetch and dispatch, the start of a quick add) and the worker (the jobs)
 * run the same logic, so it lives in one module without controllers. The outbound HTTP, crypto, rate limit, queue and database providers
 * come from the global infrastructure modules both processes load. The worker does not load `CatalogModule`, so the quick add's runner
 * and the sync (its adoption of the supplier's main box, decision 042) get their own `ServiceImporter` and the `CatalogSignals` it writes
 * the search index's events with (it needs only the outbox, a global platform provider).
 */
@Module({
  imports: [OrdersEngineModule, SettingsModule, CatalogPricesModule],
  providers: [
    AuditService,
    CatalogSignals,
    ServiceImporter,
    SupplierClient,
    SupplierThrottle,
    SupplierSync,
    SupplierDispatch,
    SupplierPoll,
    QuickAddOutbox,
    QuickAddRunner,
  ],
  exports: [
    SupplierClient,
    SupplierThrottle,
    SupplierSync,
    SupplierDispatch,
    SupplierPoll,
    QuickAddOutbox,
    QuickAddRunner,
    OrdersEngineModule,
  ],
})
export class SupplierEngineModule {}
