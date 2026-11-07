// Nest module of the price change scan job (catalog module). Import it in the worker process only (src/worker.module.ts).
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog.module';
import { CatalogPricesModule } from '../catalog-prices.module';
import { PriceChangeScanProcessor } from './price-change-scan.processor';

/**
 * Provides the processor of `service_price_scan`.
 *
 * Why: the API only asks for a scan (a delayed job added by the price version); the worker runs it (decision 020). The scan itself
 * lives in `CatalogPricesModule`, next to the version that asks for it, and needs the resolver of `CatalogModule`.
 */
@Module({ imports: [CatalogModule, CatalogPricesModule], providers: [PriceChangeScanProcessor] })
export class PriceChangeScanModule {}
