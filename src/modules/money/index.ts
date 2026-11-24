// Public API of the money module: the module and the services other modules call (decision 016): opening a merchant's
// accounts, the ledger writer with the 13 money event builders, and the wallet figures.
// Order matters (decision 032): the seams and the pure helpers other modules code against come first (no dependencies), ahead of the module
// and of the services whose providers lead into identity: the wallet kind of a rank, the account top-up lock, the registry of the rank
// change checks, the account wallet reads and the erasure of an account's wallets (decision 064).
export { walletKindOfRank } from './domain/wallet-kinds';
export type { WalletLedgerKind } from './domain/wallet-kinds';
export { lockAccountTopUps } from './infra/topup-lock.repository';
export { RankChangeGuards } from './ports/rank-change-guards';
export type { RankBlockerCode, RankChangeCheck } from './ports/rank-change-guards';
export { AccountWallets } from './ports/account-wallets';
export type { AccountWalletKind, AccountWalletView } from './ports/account-wallets';
export { WalletErasure } from './ports/wallet-erasure';
export { ShopCurrencyReads } from './ports/shop-currency-reads';
export type { ShopCurrencyFact, TaxWindowFact } from './ports/shop-currency-reads';
export { MoneyModule } from './money.module';
export { MerchantAccounts } from './application/merchant-accounts';
export type { OpenMerchantAccountsInput, OpenedWallet } from './application/merchant-accounts';
export { MerchantWallets } from './application/merchant-wallets';
export { StorefrontMoney } from './application/storefront-money';
export type { StorefrontCurrency, StorefrontPaymentMethod, TaxInForce } from './application/storefront-money';
export { OrderSettlements } from './application/order-settlements';
export type { Settlement } from './application/order-settlements';
export { orderPaymentStatus } from './application/order-payment-status';
export { WalletLowBalanceWatch } from './application/wallet-low-balance-watch';
export { LOW_BALANCE_THRESHOLD_KEY, availableOf, crossedBelow, thresholdFrom } from './domain/low-balance';
export { LedgerPoster, LedgerRefRequiredError, postTransaction } from './application/post-transaction';
export type { PostTransactionInput, PostedAccount, PostedTransaction } from './application/post-transaction';
export { WalletService } from './application/wallet.service';
export { ReconcileService, compareLedgerBalances } from './application/reconcile.service';
export type { ReconcileReport } from './application/reconcile.service';
export { MoneyAdminModule } from './money-admin.module';
export { StorefrontPayments } from './application/storefront-payments';
export type {
  CapturedSession,
  HeldConfirmation,
  RecordedCapture,
  StartPaymentInput,
  StartedPayment,
} from './application/storefront-payments';
export { OrderReceipts } from './application/order-receipts';
export {
  CONFIRMATION_GRACE_MINUTES,
  LATE_REFUND_REASON,
  brandLine,
  lateConfirmationSignal,
  minutesLate,
  paymentFacts,
  storefrontMismatch,
} from './domain/b2c-money';
export { invoiceWireSide, paymentRef } from './domain/invoice-rules';
export { aftermathNote } from './domain/payment-rules';
export type { PaymentAftermath } from './domain/payment-rules';
export type { PaymentCheck } from './infra/gateway-drivers/driver';
export { B2cRefunds } from './application/b2c-refunds';
export type { PostedRefund, RefundActor, RefundLeft, RefundPosting } from './application/b2c-refunds';
export { ReceiptBuyerPorts, StorefrontCaptures, StorefrontOrderPorts } from './application/storefront-ports';
export type {
  CaptureOutcome,
  CaptureRequest,
  PortActor,
  PortTimelineLine,
  ReceiptBuyer,
  ReceiptBuyerPort,
  RefundedOrder,
  StorefrontCapture,
  StorefrontOrderPort,
} from './application/storefront-ports';
export { REFUND_PROCESS_EVENT, RefundOutbox } from './application/refund-outbox';
export {
  ACCOUNT_OWNER_TYPE,
  BASE_CURRENCY,
  CREDIT_NORMAL_KINDS,
  DEBIT_NORMAL_KINDS,
  balanceDelta,
  holdAccountOf,
  liveWalletFigures,
  normalSideOf,
  storeWalletAccountOf,
  toDebitPositive,
  walletAccountOf,
  walletViewOf,
} from './domain/accounts';
export type { LiveWalletFacts, NormalSide, WalletView } from './domain/accounts';
export {
  BASE_CURRENCY_DEFINITION,
  PER_OWNER_ACCOUNT_KINDS,
  SYSTEM_LEDGER_ACCOUNT_KINDS,
  systemLedgerAccountRows,
} from './domain/reference-data';
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
export { TOP_UP_SCREENING_UNAVAILABLE, TopUpScreeningHooks } from './application/top-up-screening-hooks';
export type {
  TopUpScreeningAnswer,
  TopUpScreeningFacts,
  TopUpScreeningHook,
} from './application/top-up-screening-hooks';
export { TopUpScreeningModule } from './top-up-screening.module';
export { StorefrontMails } from './application/storefront-mails';
export { StorefrontMailsModule } from './storefront-mails.module';
export { PaymentAutoCreditModule, PAYMENT_AUTO_CREDIT_SCHEDULER } from './jobs/payment-auto-credit.module';
export { PAYMENT_AUTO_CREDIT_JOB } from './jobs/payment-auto-credit.processor';
export { FxRefreshJobModule, FX_REFRESH_SCHEDULER } from './jobs/fx-refresh.module';
export { FX_REFRESH_JOB } from './jobs/fx-refresh.processor';
export { AUTO_CREDIT_BATCH, PaymentAutoCredit } from './jobs/payment-auto-credit';
export type { AutoCreditSummary } from './jobs/payment-auto-credit';
export { ReceiptRenderModule } from './jobs/receipt-render.module';
export { ReceiptRenderProcessor } from './jobs/receipt-render.processor';
export { RECEIPT_RENDER_EVENT, ReceiptOutbox } from './application/receipt-outbox';
export type { ReceiptRenderResult } from './application/order-receipts';
export { RefundProcessModule } from './jobs/refund-process.module';
export { RefundSender } from './jobs/refund-sender';
// Decision 055: the lost-work pass of storefront refunds.
export { REFUND_SEND_LOST_NOTE, RefundReconcilePass } from './jobs/refund-reconcile';
export { REFUND_RESEND_WINDOW_MS, b2cWalletRefundPosting } from './domain/refund-rules';
export type { WalletRefundPosting } from './domain/refund-rules';
export type { RefundSendResult } from './jobs/refund-sender';
export { GATEWAY_HTTP_POLICY } from './infra/gateway-drivers/driver';
export type { GatewayHttpPolicy } from './infra/gateway-drivers/driver';
export { REQUIRE_3DS_KEY, asks3ds, topupMethodOf } from './domain/gateway-rules';
export {
  ADJUST_APPROVAL_LIMIT_KEY,
  approvalLimitOf,
  creditLimitNeedsOwner,
  creditLimitOwnerDetail,
} from './domain/wallet-rules';
export {
  WALLET_EVENT_IDS,
  WALLET_EVENT_KINDS,
  b2cWalletPay,
  b2cWalletRefund,
  clawbackSplit,
  customerAdjust,
  customerTopup,
  customerWalletAccount,
  topupChargeback,
} from './domain/customer-wallet-events';
export type { TopUpOwner, WalletEventId, WalletEventPosting } from './domain/customer-wallet-events';
export {
  CUSTOMER_WALLET_EVENTS,
  CUSTOMER_WALLET_RULES_MIGRATION,
  CUSTOMER_WALLET_TEMPLATES,
  customerWalletTemplatesSql,
} from './application/customer-wallet-notifications';
export { CustomerWallets } from './application/customer-wallets';
export type { AdminWallet, StoreWallet, WalletExport, WalletPeek } from './application/customer-wallets';
export { CustomerWalletMails } from './application/customer-wallet-mails';
export { BALANCE_BRAND, CustomerWalletPayments } from './application/customer-wallet-payments';
export type {
  BalancePaymentInput,
  BalancePaymentReplay,
  BalancePaymentView,
} from './application/customer-wallet-payments';
export { customerWalletPolicy } from './domain/customer-wallet-policy';
export type { CustomerWalletPolicy } from './domain/customer-wallet-policy';
// The money participant of the guest claim (decision 064): the wiring registers it with the identity registry.
export { GUEST_CLAIM_MONEY_NAME, moveGuestClaimMoney } from './application/guest-claim.participant';
