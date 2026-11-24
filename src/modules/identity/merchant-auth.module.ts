// The account sign-in of the identity module (decision 064; the file keeps its first name): the merchant portal's routes (/client/auth/*,
// /client/profile, /client/security/*, stage 2) and the services behind every rank's sign-in, links, password, two-step check and own
// profile, which the store routes of the customers module call through their ports. Separate from SecurityModule so tests without a
// database can leave it out.
import { Module } from '@nestjs/common';
import { AccountEmailVerificationService } from './application/account-email-verification.service';
import { AccountIdentityRegistrar } from './application/account-identity-registrar';
import { AccountLinkSignInService } from './application/account-link-sign-in.service';
import { AccountPasswordService } from './application/account-password.service';
import { AccountSignInLimiter } from './application/account-sign-in-limiter';
import { AccountSignInService } from './application/account-sign-in.service';
import { AccountTwoFactorService } from './application/account-two-factor.service';
import { GuestClaimService } from './application/guest-claim.service';
import { MerchantAccountReader } from './application/merchant-account-reader';
import { MerchantAccountService } from './application/merchant-account.service';
import { MerchantAuthTokens } from './application/merchant-auth-tokens';
import { TotpService } from './application/totp.service';
import { MerchantAccountController } from './controllers/merchant-account.controller';
import { MerchantAuthController } from './controllers/merchant-auth.controller';
import { MerchantMailModule } from './merchant-mail.module';
import {
  AccountEmailVerification,
  AccountLinkSignIn,
  AccountOwnPassword,
  AccountSignIn,
  AccountTwoFactorSetup,
} from './ports/account-auth';
import { AccountOwnProfile } from './ports/account-own-profile';
import { SignInLockModule } from './sign-in-lock.module';

/**
 * Provides the merchant portal routes of feature 2b and the account sign-in services of every rank, bound to their ports.
 *
 * Why: decision 064 gives merchants and customers one sign-in: the password and two-step sign-in, the email link sign-in with the guest
 * claim, the email verification, the own password and two-step setup and the own profile are one set of services; the merchant routes
 * here and the store routes of the customers module (which import this module) call them through the abstract ports. The routes need the
 * global database, crypto, rate-limit and platform outbox providers, the security stack (sessions, cookies, CSRF, the capability token
 * resolvers), the account records (`AccountsModule`, global), the catalog's group directory and `RankGroupReads` (the global
 * `CatalogModule`; not imported here: the catalog's barrel leads back into identity, so naming it in this decorator would read it before it
 * is initialised) and, through `MerchantMailModule`, the link tokens and the mail outbox.
 *
 * Port bindings: `AccountSignIn` is `AccountSignInService`, `AccountTwoFactorSetup` is `AccountTwoFactorService`, `AccountOwnPassword` is
 * `AccountPasswordService`, `AccountLinkSignIn` is `AccountLinkSignInService`, `AccountEmailVerification` is
 * `AccountEmailVerificationService`, `AccountOwnProfile` is `MerchantAccountService`.
 *
 * Side effects at boot: `AccountSignInService` computes its dummy hash; `AccountIdentityRegistrar` registers the `link-token` resolver
 * (API process only: the worker never loads this module).
 */
@Module({
  imports: [MerchantMailModule, SignInLockModule],
  controllers: [MerchantAuthController, MerchantAccountController],
  providers: [
    TotpService,
    MerchantAuthTokens,
    MerchantAccountReader,
    AccountSignInLimiter,
    AccountPasswordService,
    AccountSignInService,
    AccountTwoFactorService,
    GuestClaimService,
    AccountLinkSignInService,
    AccountEmailVerificationService,
    AccountIdentityRegistrar,
    MerchantAccountService,
    { provide: AccountSignIn, useExisting: AccountSignInService },
    { provide: AccountTwoFactorSetup, useExisting: AccountTwoFactorService },
    { provide: AccountOwnPassword, useExisting: AccountPasswordService },
    { provide: AccountLinkSignIn, useExisting: AccountLinkSignInService },
    { provide: AccountEmailVerification, useExisting: AccountEmailVerificationService },
    { provide: AccountOwnProfile, useExisting: MerchantAccountService },
  ],
  exports: [
    MerchantAuthTokens,
    MerchantMailModule,
    AccountSignInLimiter,
    AccountSignIn,
    AccountTwoFactorSetup,
    AccountOwnPassword,
    AccountLinkSignIn,
    AccountEmailVerification,
    AccountOwnProfile,
  ],
})
export class MerchantAuthModule {}
