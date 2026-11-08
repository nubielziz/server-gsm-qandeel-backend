// Public API of the customers module: the checkout rules other modules share (session lifetime, the consent purposes and how a
// session's status is judged), the read-only storefront funnel (shared by the dashboard and the funnel report), then the modules:
// the checkout, the customer accounts and the customer mail module (the worker loads it). Other modules import only this file.
export {
  CHECKOUT_IMEI_AAD,
  CHECKOUT_SESSION_TTL_MINUTES,
  LEGAL_TYPE_OF_PURPOSE,
  effectiveStatus,
  requiredConsents,
} from './domain/checkout';
export { storefrontFunnel, type StorefrontFunnel } from './storefront-funnel';
export { CheckoutModule } from './checkout.module';
export { CustomersModule } from './customers.module';
export { CustomersAccountsModule } from './customers-accounts.module';
export { CustomerMailModule } from './customer-mail.module';
export { CUSTOMER_MAIL_EVENTS } from './application/mail/customer-mail-outbox';
export type { CustomerMailKind } from './application/mail/customer-mail-outbox';
