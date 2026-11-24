// Storefront customers & checkout module (map domain I): B2C customers, credentials, checkout sessions and consents (docs/ARCHITECTURE.md § 2).
// Stage 14 built the checkout (sessions and consents, feature 14a) and the customer accounts (store sign-in, the account, the admin
// customers; feature 14b); stage 19 adds the funnel report.
import { Module } from '@nestjs/common';
import { CheckoutModule } from './checkout.module';
import { CustomerDirectoryModule } from './customer-directory.module';
import { CustomerErasureModule } from './customer-erasure.module';
import { CustomersAccountsModule } from './customers-accounts.module';
import { GrowthModule } from './growth.module';
import { CustomerNotificationsModule } from './notifications/customer-notifications.module';

/**
 * Nest module for Storefront customers & checkout (map domain I).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). The routes with their use cases (`CheckoutModule`, `CustomersAccountsModule`, whose providers need the database
 * and the cache) are separate so a test app built without a database can leave out what needs it. `CustomerDirectoryModule` is loaded
 * here too, so the slots of orders and money it fills at boot are filled whatever else the API loads.
 */
@Module({
  imports: [
    CheckoutModule,
    CustomersAccountsModule,
    GrowthModule,
    CustomerDirectoryModule,
    CustomerErasureModule,
    CustomerNotificationsModule,
  ],
})
export class CustomersModule {}
