// The account records of the identity module (decision 064): the directory, the legacy id map and the rank writer, with the three
// registries other modules fill at boot (the create checks, the guest-claim participants, the SQL of the account list). Loaded by the API
// (through IdentityModule) and by the worker (through MerchantMailModule): the jobs read and lock accounts as much as the routes do.
import { Global, Module } from '@nestjs/common';
import { AccountDirectory } from './accounts/account-directory';
import { AccountRanks } from './accounts/account-ranks';
import { LegacyAccounts } from './accounts/legacy-accounts';
import { AccountCreateGuards } from './ports/account-create-guards';
import { AccountListSql } from './ports/account-list-sql';
import { GuestClaimParticipants } from './ports/guest-claim-participants';

/**
 * Provides and exports `AccountDirectory`, `LegacyAccounts`, `AccountRanks` and the registries `AccountCreateGuards`,
 * `GuestClaimParticipants` and `AccountListSql`, once for the process.
 *
 * Why: merchants and customers are one account type (decision 064). Orders, money, customers, risk and support read and lock an account
 * only through `AccountDirectory`, in both processes, so the module is global. A registry collects the entries other modules register at
 * boot (a repeated name throws), so each must be one instance that the registering module and the consumer share. The rank reads come
 * from the catalog's global `RankGroupReads`; the clock from the global clock module.
 *
 * Side effects: none at boot; the entries are added by the modules that own them (see `AccountWiringCheckModule` for the list).
 */
@Global()
@Module({
  providers: [
    AccountDirectory,
    LegacyAccounts,
    AccountRanks,
    AccountCreateGuards,
    GuestClaimParticipants,
    AccountListSql,
  ],
  exports: [
    AccountDirectory,
    LegacyAccounts,
    AccountRanks,
    AccountCreateGuards,
    GuestClaimParticipants,
    AccountListSql,
  ],
})
export class AccountsModule {}
