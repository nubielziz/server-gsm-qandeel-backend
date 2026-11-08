// The storefront customer accounts of the customers module (stage 14, feature 14b): store sign-in (/store/v1/auth/*), the account
// (/store/v1/me*) and the admin customer routes (/admin/customers*), with the use cases behind them. Separate from CustomersModule
// so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { CustomerTokensModule } from '../identity';
import { CustomerAccountAdminService } from './application/customer-account-admin.service';
import { CustomerAccountService } from './application/customer-account.service';
import { CustomerAdminService } from './application/customer-admin.service';
import { CustomerIdentityRegistrar } from './application/customer-identity-registrar';
import { CustomerLinks } from './application/customer-links';
import { CustomerPasswordService } from './application/customer-password.service';
import { CustomerSignInLimiter } from './application/customer-sign-in-limiter';
import { CustomerSignInService } from './application/customer-sign-in.service';
import { CustomersController } from './controllers/customers.controller';
import { StoreAccountController } from './controllers/store-account.controller';
import { StoreAuthController } from './controllers/store-auth.controller';
import { CustomerMailModule } from './customer-mail.module';
import { CustomerSignInFailures } from './infra/customer-sign-in-failures';

/**
 * Provides the 19 customer routes of feature 14b (7 store sign-in, 3 account, 9 admin) and registers the customer resolvers
 * with the security stack.
 *
 * Why: the routes need the global database, crypto, rate-limit, audit and outbox providers and the security stack (sessions,
 * cookies, CSRF); the customer mails and the one-time link service come from their own modules because the worker loads those
 * without the routes.
 */
@Module({
  imports: [CustomerTokensModule, CustomerMailModule],
  controllers: [StoreAuthController, StoreAccountController, CustomersController],
  providers: [
    CustomerSignInLimiter,
    CustomerSignInFailures,
    CustomerLinks,
    CustomerSignInService,
    CustomerPasswordService,
    CustomerAccountService,
    CustomerAdminService,
    CustomerAccountAdminService,
    CustomerIdentityRegistrar,
  ],
})
export class CustomersAccountsModule {}
