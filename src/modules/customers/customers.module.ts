// Storefront customers & checkout module (map domain I): B2C customers, credentials, checkout sessions and consents (docs/ARCHITECTURE.md § 2).
// Stage 14 built the checkout (sessions and consents, feature 14a) and the customer accounts (store sign-in, the account, the admin
// customers; feature 14b); stage 19 adds the Checkouts page (abandoned list, recovery send, funnel).
import { Module } from '@nestjs/common';
import { CheckoutModule } from './checkout.module';
import { CustomersAccountsModule } from './customers-accounts.module';
import { GrowthModule } from './growth.module';

/**
 * Nest module for Storefront customers & checkout (map domain I).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). The routes with their use cases (`CheckoutModule`, `CustomersAccountsModule`, whose providers need the database
 * and the cache) are separate so a test app built without a database can leave out what needs it.
 */
@Module({ imports: [CheckoutModule, CustomersAccountsModule, GrowthModule] })
export class CustomersModule {}
