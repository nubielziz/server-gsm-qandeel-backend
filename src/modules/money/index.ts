// Public API of the money module: the module and the services other modules call (decision 016): opening a merchant's
// accounts, the ledger writer with the 13 money event builders, and the wallet figures.
export { MoneyModule } from './money.module';
export { MerchantAccounts } from './application/merchant-accounts';
export type { OpenMerchantAccountsInput, OpenedWallet } from './application/merchant-accounts';
export { MerchantWallets } from './application/merchant-wallets';
export { MerchantSpend } from './application/merchant-spend';
export { StorefrontMoney } from './application/storefront-money';
export type { StorefrontCurrency, StorefrontPaymentMethod, TaxInForce } from './application/storefront-money';
export { OrderSettlements } from './application/order-settlements';
export type { Settlement } from './application/order-settlements';
export { WalletLowBalanceWatch } from './application/wallet-low-balance-watch';
export { LOW_BALANCE_THRESHOLD_KEY, availableOf, crossedBelow, thresholdFrom } from './domain/low-balance';
export { LedgerPoster, LedgerRefRequiredError, postTransaction } from './application/post-transaction';
export type { PostTransactionInput, PostedAccount, PostedTransaction } from './application/post-transaction';
export { WalletService } from './application/wallet.service';
export {
  BASE_CURRENCY,
  CREDIT_NORMAL_KINDS,
  DEBIT_NORMAL_KINDS,
  balanceDelta,
  normalSideOf,
  toDebitPositive,
  walletViewOf,
} from './domain/accounts';
export type { NormalSide, WalletView } from './domain/accounts';
export { assertBalanced, creditLine, debitLine } from './domain/ledger-lines';
export type { AccountRef, LedgerLine } from './domain/ledger-lines';
export {
  MONEY_EVENT_IDS,
  MONEY_EVENT_KINDS,
  adjust,
  b2cChargeback,
  b2cDeliver,
  b2cFee,
  b2cPay,
  b2cRefund,
  commission,
  complete,
  deposit,
  order,
  payout,
  REVERSAL_EVENT_IDS,
  REVERSAL_KINDS,
  refund,
  reject,
  reopen,
  reopenB2c,
  topup,
} from './domain/money-events';
export type { MoneyEventId, MoneyEventPosting, ReversalEventId, ReversalPosting } from './domain/money-events';
export { isRateStale } from './domain/currency-rules';
export { WIRE_REF_TYPES, storedRefTypesOf, toWireRefType } from './domain/ref-types';
export type { WireRefType } from './domain/ref-types';
export { PaymentGateways } from './application/payment-gateways';
export { INVOICE_PAID_EVENT, InvoiceOutbox } from './application/invoice-outbox';
export { MoneyOutboxModule } from './money-outbox.module';
export { PaymentAutoCreditModule, PAYMENT_AUTO_CREDIT_SCHEDULER } from './jobs/payment-auto-credit.module';
export { PAYMENT_AUTO_CREDIT_JOB } from './jobs/payment-auto-credit.processor';
export { AUTO_CREDIT_BATCH, PaymentAutoCredit } from './jobs/payment-auto-credit';
export type { AutoCreditSummary } from './jobs/payment-auto-credit';
export { GATEWAY_HTTP_POLICY } from './infra/gateway-drivers/driver';
export type { GatewayHttpPolicy } from './infra/gateway-drivers/driver';
export { topupMethodOf } from './domain/gateway-rules';
