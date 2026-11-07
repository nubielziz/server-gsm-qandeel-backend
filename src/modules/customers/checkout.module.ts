// The routes and use cases of the storefront checkout (stage 14): open a session, read it, record consents, and the checkout token
// resolver. Separate from CustomersModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { CheckoutSessionService } from './application/checkout-session.service';
import { CheckoutTokenResolver } from './application/checkout-token.resolver';
import { ConsentService } from './application/consent.service';
import { CheckoutController } from './controllers/checkout.controller';

/**
 * Provides `/store/v1/checkout-sessions*`.
 *
 * Why: these use cases need the global database, crypto, clock, catalog, money and storefront providers and the identity guard's
 * resolver registry, which a database-less test app does not have.
 */
@Module({
  controllers: [CheckoutController],
  providers: [CheckoutSessionService, ConsentService, CheckoutTokenResolver],
})
export class CheckoutModule {}
