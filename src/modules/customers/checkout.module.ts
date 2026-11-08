// The routes and use cases of the storefront checkout (stages 14 and 16): open a session, read it, record consents, pay it, the capture of a confirmed payment, and the checkout token
// resolver. Separate from CustomersModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { MoneyAdminModule, StorefrontMailsModule } from '../money';
import { CheckoutCaptureService } from './application/checkout-capture.service';
import { CheckoutPayService } from './application/checkout-pay.service';
import { CheckoutSessionService } from './application/checkout-session.service';
import { CheckoutTokenResolver } from './application/checkout-token.resolver';
import { ConsentService } from './application/consent.service';
import { OptionalCustomerSession } from './application/optional-customer-session';
import { CheckoutController } from './controllers/checkout.controller';

/**
 * Provides `/store/v1/checkout-sessions*` (open, read, consents and pay) and the capture that turns a confirmed payment into the order.
 *
 * Why: these use cases need the global database, crypto, clock, catalog, money and storefront providers and the identity guard's
 * resolver registry, which a database-less test app does not have. It imports `MoneyAdminModule` for `StorefrontPayments` (the pay call and
 * the capture): a test app that leaves this module out leaves that import out with it.
 */
@Module({
  imports: [MoneyAdminModule, StorefrontMailsModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutSessionService,
    ConsentService,
    CheckoutTokenResolver,
    OptionalCustomerSession,
    CheckoutPayService,
    CheckoutCaptureService,
  ],
})
export class CheckoutModule {}
