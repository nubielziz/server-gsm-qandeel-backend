// The account management routes of the identity module (stage 2, route group /admin/clients; one account type, decision 064): controllers,
// the staff use cases (list, detail, create, edit, security, guest rows, the legacy id lookup), the access effects of a status or rank
// change, and the seam for the orders module's 30-day figures. Separate so a test app built without a database can leave it out.
import { Global, Module } from '@nestjs/common';
import { AccountAccessEffectsService } from './application/account-access-effects';
import { AccountCountsService } from './application/account-counts.service';
import { AccountCreateChecks } from './application/account-create-guards';
import { AccountGuestService } from './application/account-guest.service';
import { ClientAdminService } from './application/client-admin.service';
import { ClientDetailsEditor } from './application/client-details-editor';
import { ClientSecurityAdminService } from './application/client-security-admin.service';
import { ClientViews } from './application/client-views';
import { ClientStatsDirectory } from './application/client-stats';
import { ClientWriteService } from './application/client-write.service';
import { MerchantGroupMembers } from './application/merchant-group-members';
import { ClientSecurityController } from './controllers/client-security.controller';
import { ClientsController } from './controllers/clients.controller';
import { LegacyAccountsController } from './controllers/legacy-accounts.controller';
import { MerchantAuthModule } from './merchant-auth.module';
import { MerchantMailModule } from './merchant-mail.module';
import { AccountAccessEffects } from './ports/account-access-effects';
import { SignInLockModule } from './sign-in-lock.module';

/**
 * Provides `/admin/clients` (every rank), the legacy id lookup, the merchant group member counts the catalog's group routes read and the
 * access effects of a status or rank change.
 *
 * Why: the routes need the global database, audit, security, account records, money (wallet accounts and views) and catalog (groups)
 * providers, and the link tokens and mail outbox of `MerchantMailModule` (the invitation and reset links). It is global because the
 * orders module injects `ClientStatsDirectory` to register its source (feature 5), and the customers and money modules inject
 * `AccountAccessEffects` (the block, the erasure and the rank change end sessions and revoke keys in the same transaction).
 *
 * Port binding: `AccountAccessEffects` is `AccountAccessEffectsService`.
 */
@Global()
@Module({
  imports: [MerchantMailModule, MerchantAuthModule, SignInLockModule],
  controllers: [ClientsController, ClientSecurityController, LegacyAccountsController],
  providers: [
    ClientAdminService,
    ClientDetailsEditor,
    ClientSecurityAdminService,
    ClientViews,
    ClientStatsDirectory,
    MerchantGroupMembers,
    AccountCountsService,
    AccountCreateChecks,
    AccountAccessEffectsService,
    { provide: AccountAccessEffects, useExisting: AccountAccessEffectsService },
    ClientWriteService,
    AccountGuestService,
  ],
  exports: [ClientStatsDirectory, MerchantGroupMembers, AccountAccessEffects],
})
export class MerchantAdminModule {}
