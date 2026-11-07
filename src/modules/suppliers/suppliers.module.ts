// Suppliers module (map domain C): suppliers, their services, the links from our services to supplier services, the Dhru supplier client and
// the log of every supplier call (docs/ARCHITECTURE.md § 2). Stage 6 adds the routes, the dispatch, poll and sync jobs.
import { Module } from '@nestjs/common';
import { SuppliersAdminModule } from './suppliers-admin.module';

/**
 * Nest module for Suppliers (map domain C).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts` (decision 016). The routes
 * and use cases are `SuppliersAdminModule`, the worker's jobs are `SupplierJobsModule`.
 */
@Module({ imports: [SuppliersAdminModule] })
export class SuppliersModule {}
