// The store accounts of the customers module (stage 14, feature 14b; one account type, decision 064): the store sign-in routes
// (/store/v1/auth/*, the shared /client/auth/sign-in), the account (/store/v1/me*, its two-step setup), the staff block and privacy routes of an
// account (/admin/clients/:id/...), the retired admin customer routes (410) and the marketing unsubscribe link, with the use cases behind
// them. Separate from CustomersModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { MerchantAuthModule, SignInLockModule } from '../identity';
import { MoneyAdminModule } from '../money';
import { RiskServicesModule } from '../risk';
import { AccountBlocklistGuard } from './application/account-blocklist-guard';
import { AccountPrivacyReadsService } from './application/account-privacy-reads.service';
import { CustomerAccountService } from './application/customer-account.service';
import { CustomerBlockService } from './application/customer-block.service';
import { CustomerPrivacyService } from './application/customer-privacy.service';
import { CustomerProfileRules } from './application/customer-profile-rules';
import { AccountPrivacyController } from './controllers/account-privacy.controller';
import { CustomerPrivacyController } from './controllers/customer-privacy.controller';
import { CustomersController } from './controllers/customers.controller';
import { SmartSignInController } from './controllers/smart-sign-in.controller';
import { StoreAccountController } from './controllers/store-account.controller';
import { StoreAuthController } from './controllers/store-auth.controller';
import { StoreTwoFactorController } from './controllers/store-two-factor.controller';
import { MarketingUnsubscribe } from './notifications/marketing-unsubscribe.service';
import { UnsubscribeController } from './notifications/unsubscribe.controller';
import { AccountPrivacyReads } from './ports/account-privacy-reads';

/**
 * Provides the store sign-in and account routes, the staff block, privacy, export and anonymize routes of an account, the 410 answers of the retired
 * admin customer routes, the unsubscribe route of feature 23's marketing emails and the blocklist check of a staff create.
 *
 * Why: decision 064 makes the sign-in one service set for every rank: the store routes call identity's ports (`AccountSignIn`,
 * `AccountLinkSignIn`, `AccountOwnPassword`, `AccountTwoFactorSetup`, `AccountOwnProfile`), which `MerchantAuthModule` binds and exports,
 * and the orders module's `ShopOrders` (global). The routes need the global database, crypto, rate-limit, audit and outbox providers, the
 * security stack (sessions, cookies, CSRF), the account records, `AccountAccessEffects` (identity, global), the failed-sign-in lock
 * (`SignInLockModule`), the risk services (blocklist, data requests) and the money admin services (the store balance and its erasure,
 * `WalletErasure`). Customers may import identity, never the reverse (decisions 032 and 052).
 *
 * Port binding: `AccountPrivacyReads` is `AccountPrivacyReadsService` (exported for the privacy routes and the export builder).
 *
 * Side effects at boot: `AccountBlocklistGuard` registers the `blocklist` check with identity's `AccountCreateGuards` (API process only).
 */
@Module({
  imports: [RiskServicesModule, MoneyAdminModule, MerchantAuthModule, SignInLockModule],
  controllers: [
    StoreAuthController,
    StoreAccountController,
    StoreTwoFactorController,
    SmartSignInController,
    AccountPrivacyController,
    // The retired admin customer routes: 410 answers until the contract release.
    CustomersController,
    CustomerPrivacyController,
    // Feature 23: the unsubscribe link of marketing emails (public; the token is the credential).
    UnsubscribeController,
  ],
  providers: [
    CustomerProfileRules,
    CustomerAccountService,
    CustomerBlockService,
    CustomerPrivacyService,
    AccountPrivacyReadsService,
    { provide: AccountPrivacyReads, useExisting: AccountPrivacyReadsService },
    AccountBlocklistGuard,
    MarketingUnsubscribe,
  ],
  exports: [AccountPrivacyReads],
})
export class CustomersAccountsModule {}
