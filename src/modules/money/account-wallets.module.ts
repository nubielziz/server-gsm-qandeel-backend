// The live wallet reads of an account (money module, decision 064) as a global module of their own: the kind of the account's live wallet,
// the views the account list shows, the frozen check before a hold. Loaded by the API and by the worker (the order engine reads the
// kind when it moves an order), through MoneyModule and MoneyOutboxModule.
import { Global, Module } from '@nestjs/common';
import { AccountWalletsService } from './application/account-wallets';
import { AccountWallets } from './ports/account-wallets';

/**
 * Provides `AccountWallets`, bound to `AccountWalletsService`, once for the process.
 *
 * Why: one live wallet per account, of the kind of its rank (decision 064). Identity's account views, the order placement and transitions
 * and money's own staff wallet, rank change and payment views all ask the port; the worker loads no route module of money, so the reads
 * sit in a global module both processes reach. It needs only the global settings reader and the clock.
 */
@Global()
@Module({
  providers: [AccountWalletsService, { provide: AccountWallets, useExisting: AccountWalletsService }],
  exports: [AccountWallets],
})
export class AccountWalletsModule {}
