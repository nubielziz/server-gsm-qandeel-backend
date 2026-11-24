// Money module (map domain E): the ledger writer, merchant wallets, the ledger screens and currencies (stage 3), and billing (stage 8:
// gateways, invoices, top-up payments, the payment webhook). Refunds and disputes arrive with their own features (docs/ARCHITECTURE.md § 2).
import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { MerchantAccounts } from './application/merchant-accounts';
import { OrderSettlements } from './application/order-settlements';
import { StorefrontMoney } from './application/storefront-money';
import { MerchantWallets } from './application/merchant-wallets';
import { WalletLowBalanceWatch } from './application/wallet-low-balance-watch';
import { LedgerPoster } from './application/post-transaction';
import { StorefrontCaptures, StorefrontOrderPorts } from './application/storefront-ports';
import { PaymentGateways } from './application/payment-gateways';
import { walletBalanceSql } from './infra/account-wallet-sql';
import { RankChangeGuards } from './ports/rank-change-guards';
import { ShopCurrencyReads } from './ports/shop-currency-reads';
// From here on the imports lead into identity, whose index leads through the catalog's group admin back into this module's index: the
// services above (MerchantWallets and PaymentGateways among them) must be initialised by then, so the order is on purpose (decision 032).
import { B2cRefunds } from './application/b2c-refunds';
import { GUEST_CLAIM_MONEY_NAME, moveGuestClaimMoney } from './application/guest-claim.participant';
import { AccountWalletsModule } from './account-wallets.module';
import { MoneyAdminModule } from './money-admin.module';
import { MoneyOutboxModule } from './money-outbox.module';
import { AccountListSql, GuestClaimParticipants } from '../identity';

/**
 * Nest module for Money (map domain E).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). It is global so that identity (merchant creation) and the later order, billing and refund features reach
 * `MerchantAccounts` and `LedgerPoster` without importing it; both work inside the caller's transaction and need no
 * database provider of their own. The routes and the services that read the database live in `MoneyAdminModule`.
 *
 * Decision 064: it also provides the one `RankChangeGuards` registry (the rank change of `MoneyAdminModule`, the orders module's
 * live-order check and the customers module's open-checkout check share it), binds identity's `ShopCurrencyReads` seam to
 * `StorefrontMoney`, and imports the global `AccountWalletsModule` (`AccountWallets`). API process only: the worker never loads this module.
 *
 * Side effects at boot: registers money's participant of the guest claim (`money`: payments, invoices, refunds and disputes of the guest
 * row) and the wallet balance fragment of the staff account list (`AccountListSql`), once each.
 */
@Global()
@Module({
  imports: [AccountWalletsModule, MoneyAdminModule, MoneyOutboxModule],
  providers: [
    MerchantAccounts,
    WalletLowBalanceWatch,
    LedgerPoster,
    MerchantWallets,
    OrderSettlements,
    PaymentGateways,
    StorefrontMoney,
    B2cRefunds,
    StorefrontCaptures,
    StorefrontOrderPorts,
    RankChangeGuards,
    { provide: ShopCurrencyReads, useExisting: StorefrontMoney },
  ],
  exports: [
    MerchantAccounts,
    LedgerPoster,
    MerchantWallets,
    OrderSettlements,
    PaymentGateways,
    StorefrontMoney,
    B2cRefunds,
    StorefrontCaptures,
    StorefrontOrderPorts,
    RankChangeGuards,
    ShopCurrencyReads,
  ],
})
export class MoneyModule implements OnModuleInit {
  constructor(
    private readonly guestClaims: GuestClaimParticipants,
    private readonly accountList: AccountListSql,
  ) {}

  /**
   * Registers money's entries in identity's registries: the guest-claim participant and the account list's wallet balance.
   *
   * Why: identity runs the claim and the list but may not read money's tables (decision 016); money owns the movers and the SQL. Both
   * are plain functions, so the registration needs no provider.
   *
   * @throws {Error} when either is already registered (a boot error)
   */
  onModuleInit(): void {
    this.guestClaims.register(GUEST_CLAIM_MONEY_NAME, moveGuestClaimMoney);
    this.accountList.registerWalletBalance(walletBalanceSql);
  }
}
