// The catalog's price version (decision 022): the one provider of the catalog module that needs the cache, so a test app
// built without the infrastructure leaves it out. Global, because the supplier sync (feature 6) and every writer of a price
// bump the version after their commit without importing the admin routes.
import { Global, Module } from '@nestjs/common';
import { CatalogPriceVersion } from './application/catalog-price-version';
import { PriceChangeScan } from './application/price-change-scan';
import { PriceVersionListeners } from './application/price-version-listeners';
import { RetailFollowScheduler } from './application/retail-follow-scheduler';

/**
 * Provides {@link CatalogPriceVersion}.
 *
 * Why: user rule 9 (c): price lists are cached under versioned keys and every writer of a resolved price moves the version.
 * It needs the cache Redis (a global module of the API and the worker), so it is separate from `CatalogModule`, which has no
 * infrastructure dependency. It also holds the two listeners every move of the version asks: the price change scan (feature 7b) and
 * the scheduler of the retail follow pass (feature 31): the API moves the version too, so they cannot live in the worker alone.
 */
@Global()
@Module({
  providers: [PriceVersionListeners, PriceChangeScan, RetailFollowScheduler, CatalogPriceVersion],
  exports: [CatalogPriceVersion, PriceChangeScan, RetailFollowScheduler],
})
export class CatalogPricesModule {}
