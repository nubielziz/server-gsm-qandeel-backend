// Public API of the money module: the module and the services other modules call (decision 016): opening a merchant's
// accounts, the ledger writer with the 13 money event builders, and the wallet figures.
export { MoneyModule } from './money.module';
export { MerchantAccounts } from './application/merchant-accounts';
export type { OpenMerchantAccountsInput, OpenedWallet } from './application/merchant-accounts';
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
  reject,
  topup,
} from './domain/money-events';
export type { MoneyEventId, MoneyEventPosting } from './domain/money-events';
export { WIRE_REF_TYPES, storedRefTypesOf, toWireRefType } from './domain/ref-types';
export type { WireRefType } from './domain/ref-types';
