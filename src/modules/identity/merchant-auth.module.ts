// The merchant portal's sign-in of the identity module (routes /client/auth/*, /client/profile, /client/security/*,
// /client/sessions; stage 2): controllers, use cases and the link-token service that merchant management (feature 2a) calls.
// Separate from SecurityModule so tests without a database can leave it out.
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { MerchantAccountReader } from './application/merchant-account-reader';
import { MerchantAccountService } from './application/merchant-account.service';
import { MerchantAuthTokens } from './application/merchant-auth-tokens';
import { MerchantPasswordService } from './application/merchant-password.service';
import { MerchantRegistrationService } from './application/merchant-registration.service';
import { MerchantSessionsService } from './application/merchant-sessions.service';
import { MerchantSignInLimiter } from './application/merchant-sign-in-limiter';
import { MerchantSignInService } from './application/merchant-sign-in.service';
import { MerchantTwoFactorService } from './application/merchant-two-factor.service';
import { TotpService } from './application/totp.service';
import { MerchantAccountController } from './controllers/merchant-account.controller';
import { MerchantAuthController } from './controllers/merchant-auth.controller';
import { MerchantMailModule } from './merchant-mail.module';

/**
 * Provides the 15 merchant portal routes of feature 2b, `MerchantAuthTokens` and (through `MerchantMailModule`) the mail outbox.
 *
 * Why: the routes need the global database, crypto, rate-limit, audit-free money (`MerchantAccounts.open`) and platform outbox
 * providers, the security stack (sessions, cookies, CSRF) and the catalog's group directory; the module is exported to the rest
 * of the app only through `index.ts`.
 */
@Module({
  imports: [CatalogModule, MerchantMailModule],
  controllers: [MerchantAuthController, MerchantAccountController],
  providers: [
    TotpService,
    MerchantSignInLimiter,
    MerchantAuthTokens,
    MerchantAccountReader,
    MerchantRegistrationService,
    MerchantSignInService,
    MerchantAccountService,
    MerchantPasswordService,
    MerchantTwoFactorService,
    MerchantSessionsService,
  ],
  exports: [MerchantAuthTokens, MerchantMailModule],
})
export class MerchantAuthModule {}
