// Money module (map domain E): the ledger writer, merchant wallets, the ledger screens and currencies (stage 3), and billing (stage 8:
// gateways, invoices, top-up payments, the payment webhook). Refunds and disputes arrive with their own features (docs/ARCHITECTURE.md § 2).
import { Global, Module } from '@nestjs/common';
import { MerchantAccounts } from './application/merchant-accounts';
import { MerchantSpend } from './application/merchant-spend';
import { OrderSettlements } from './application/order-settlements';
import { MerchantWallets } from './application/merchant-wallets';
import { WalletLowBalanceWatch } from './application/wallet-low-balance-watch';
import { LedgerPoster } from './application/post-transaction';
import { PaymentGateways } from './application/payment-gateways';
import { MoneyAdminModule } from './money-admin.module';
import { MoneyOutboxModule } from './money-outbox.module';

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
  imports: [MoneyAdminModule, MoneyOutboxModule],
  providers: [
    MerchantAccounts,
    WalletLowBalanceWatch,
    LedgerPoster,
    MerchantWallets,
    MerchantSpend,
    OrderSettlements,
    PaymentGateways,
  ],
  exports: [MerchantAccounts, LedgerPoster, MerchantWallets, MerchantSpend, OrderSettlements, PaymentGateways],
})
export class MoneyModule {}
