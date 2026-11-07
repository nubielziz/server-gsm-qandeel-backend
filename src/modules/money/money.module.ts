// Money module (map domain E): the ledger writer, merchant wallets, the ledger screens and currencies (stage 3). Invoices,
// gateways, payments, refunds, disputes and tax rates arrive with their own features (docs/ARCHITECTURE.md § 2).
import { Global, Module } from '@nestjs/common';
import { MerchantAccounts } from './application/merchant-accounts';
import { MerchantSpend } from './application/merchant-spend';
import { MerchantWallets } from './application/merchant-wallets';
import { LedgerPoster } from './application/post-transaction';
import { MoneyAdminModule } from './money-admin.module';

/**
 * Nest module for Money (map domain E).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). It is global so that identity (merchant creation) and the later order, billing and refund features reach
 * `MerchantAccounts` and `LedgerPoster` without importing it; both work inside the caller's transaction and need no
 * database provider of their own. The routes and the services that read the database live in `MoneyAdminModule`.
 */
@Global()
@Module({
  imports: [MoneyAdminModule],
  providers: [MerchantAccounts, LedgerPoster, MerchantWallets, MerchantSpend],
  exports: [MerchantAccounts, LedgerPoster, MerchantWallets, MerchantSpend],
})
export class MoneyModule {}
