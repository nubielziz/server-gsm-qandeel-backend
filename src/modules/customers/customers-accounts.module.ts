// The storefront customer accounts of the customers module (stage 14, feature 14b): store sign-in (/store/v1/auth/*), the account
// (/store/v1/me*) and the admin customer routes (/admin/customers*), with the use cases behind them. Separate from CustomersModule
// so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { CustomerTokensModule, MerchantAuthModule } from '../identity';
import { MoneyAdminModule } from '../money';
import { RiskServicesModule } from '../risk';
import { CustomerAccountAdminService } from './application/customer-account-admin.service';
import { CustomerAccountService } from './application/customer-account.service';
import { CustomerAdminService } from './application/customer-admin.service';
import { CustomerProfileRules } from './application/customer-profile-rules';
import { CustomerBlockService } from './application/customer-block.service';
import { CustomerIdentityRegistrar } from './application/customer-identity-registrar';
import { CustomerLinks } from './application/customer-links';
import { CustomerPasswordService } from './application/customer-password.service';
import { CustomerPrivacyService } from './application/customer-privacy.service';
import { CustomerSignInLimiter } from './application/customer-sign-in-limiter';
import { CustomerSignInService } from './application/customer-sign-in.service';
import { SmartSignInService } from './application/smart-sign-in.service';
import { CustomerPrivacyController } from './controllers/customer-privacy.controller';
import { CustomersController } from './controllers/customers.controller';
import { SmartSignInController } from './controllers/smart-sign-in.controller';
import { StoreAccountController } from './controllers/store-account.controller';
import { StoreAuthController } from './controllers/store-auth.controller';
import { CustomerMailModule } from './customer-mail.module';
import { CustomerSignInFailures } from './infra/customer-sign-in-failures';
import { MarketingUnsubscribe } from './notifications/marketing-unsubscribe.service';
import { UnsubscribeController } from './notifications/unsubscribe.controller';

/**
 * Provides the 19 customer routes of feature 14b (7 store sign-in, 3 account, 9 admin), the 3 admin privacy routes of feature 18
 * (block, export, anonymize), the unsubscribe route of feature 23's marketing emails, the smart sign-in of feature 24A
 * (`POST /client/auth/sign-in`) and registers the customer resolvers with the security stack.
 *
 * Why: the routes need the global database, crypto, rate-limit, audit and outbox providers and the security stack (sessions,
 * cookies, CSRF); the customer mails and the one-time link service come from their own modules because the worker loads those
 * without the routes. The smart sign-in takes the merchant side from identity's `MerchantAuthModule` (customers may import identity,
 * never the reverse, decision 032).
 */
@Module({
  imports: [CustomerTokensModule, CustomerMailModule, RiskServicesModule, MoneyAdminModule, MerchantAuthModule],
  controllers: [
    StoreAuthController,
    StoreAccountController,
    CustomersController,
    CustomerPrivacyController,
    // Feature 23: the unsubscribe link of marketing emails (public; the token is the credential).
    UnsubscribeController,
    SmartSignInController,
  ],
  providers: [
    CustomerSignInLimiter,
    CustomerSignInFailures,
    CustomerLinks,
    CustomerSignInService,
    SmartSignInService,
    CustomerPasswordService,
    CustomerProfileRules,
    CustomerAccountService,
    CustomerAdminService,
    CustomerAccountAdminService,
    CustomerBlockService,
    CustomerPrivacyService,
    CustomerIdentityRegistrar,
    MarketingUnsubscribe,
  ],
})
export class CustomersAccountsModule {}
