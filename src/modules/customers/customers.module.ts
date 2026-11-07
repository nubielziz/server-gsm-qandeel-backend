// Storefront customers & checkout module (map domain I): B2C customers, credentials, checkout sessions and consents (docs/ARCHITECTURE.md § 2).
// Stage 14 built the checkout (sessions and consents); store sign-in, accounts and the admin customer routes arrive with 14b.
import { Module } from '@nestjs/common';
import { CheckoutModule } from './checkout.module';

/**
 * Nest module for Storefront customers & checkout (map domain I).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). The routes with their use cases (`CheckoutModule`) are separate so a test app built without a database can
 * leave out what needs it.
 */
@Module({ imports: [CheckoutModule] })
export class CustomersModule {}
