// Public API of the customers module: the checkout rules other modules share (session lifetime, the consent purposes and how a
// session's status is judged), the read-only storefront funnel (shared by the dashboard and the funnel report), the customer directory
// (find or make a guest customer), then the modules: the checkout, the customer accounts and the customer mail module (the worker loads
// the mail module). Other modules import only this file.
export {
  CHECKOUT_IMEI_AAD,
  CHECKOUT_SESSION_TTL_MINUTES,
  LEGAL_TYPE_OF_PURPOSE,
  effectiveStatus,
  requiredConsents,
} from './domain/checkout';
export { storefrontFunnel, type StorefrontFunnel } from './storefront-funnel';
export { CustomerDirectory, type CustomerRef, type OrderLinkStanding } from './application/customer-directory';
export { CustomerDirectoryModule } from './customer-directory.module';
export { CheckoutModule } from './checkout.module';
export { GrowthModule } from './growth.module';
export { CustomersModule } from './customers.module';
export { CustomersAccountsModule } from './customers-accounts.module';
export { CustomerMailModule } from './customer-mail.module';
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
export { CustomerErasureHooks } from './application/customer-erasure-hooks';
export type { CustomerErasureHook } from './application/customer-erasure-hooks';
export { CUSTOMER_MAIL_EVENTS } from './application/mail/customer-mail-outbox';
export type { CustomerMailKind } from './application/mail/customer-mail-outbox';
