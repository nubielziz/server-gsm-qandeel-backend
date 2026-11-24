// Public API of the customers module: the checkout rules other modules share (session lifetime, the consent purposes and how a
// session's status is judged), the read-only storefront funnel (shared by the dashboard and the funnel report), the customer directory
// (the buyer facts the orders and money modules read, by account id), then the modules: the checkout and the customer accounts. Other modules import only this file.
// The privacy facts of an account (a port with no dependencies; decision 064): the staff detail of the identity module reads them through it.
export { AccountPrivacyReads } from './ports/account-privacy-reads';
export type { AccountConsentRecord, AccountPrivacy } from './ports/account-privacy-reads';
export {
  CHECKOUT_IMEI_AAD,
  CHECKOUT_SESSION_TTL_MINUTES,
  LEGAL_TYPE_OF_PURPOSE,
  effectiveStatus,
  requiredConsents,
} from './domain/checkout';
export { storefrontFunnel, type StorefrontFunnel } from './storefront-funnel';
export { CustomerDirectory, type OrderLinkStanding } from './application/customer-directory';
export { CustomerDirectoryModule } from './customer-directory.module';
export { CheckoutModule } from './checkout.module';
export { GrowthModule } from './growth.module';
export { CustomersModule } from './customers.module';
export { CustomersAccountsModule } from './customers-accounts.module';
// The one-off seal pass of the checkout tokens stored as issued (decision 054); its module is loaded by the worker only.
export {
  CHECKOUT_TOKENS_SEAL_EVENT,
  CHECKOUT_TOKENS_SEAL_JOB,
  CheckoutTokenSeal,
} from './application/checkout-token-seal';
export { CheckoutTokenSealModule } from './jobs/checkout-token-seal.module';
export { CustomerErasureModule } from './customer-erasure.module';
export { CustomerNotificationsModule } from './notifications/customer-notifications.module';
export { CustomerAudience } from './notifications/customer-audience';
export { AccountErasureHooks } from './application/customer-erasure-hooks';
export type { AccountErasureHook } from './application/customer-erasure-hooks';
