// Public API of the customers module: the checkout rules other modules share (session lifetime, the consent purposes and how a
// session's status is judged), the read-only storefront funnel (shared by the dashboard and the funnel report), the recovery rules, the
// customer directory (find or make a guest customer), then the modules: the checkout, the customer accounts, the customer mail module and
// the checkout recovery module (the worker loads both). Other modules import only this file.
export {
  CHECKOUT_IMEI_AAD,
  CHECKOUT_SESSION_TTL_MINUTES,
  LEGAL_TYPE_OF_PURPOSE,
  effectiveStatus,
  requiredConsents,
} from './domain/checkout';
export { storefrontFunnel, type StorefrontFunnel } from './storefront-funnel';
export { CustomerDirectory, type CustomerRef } from './application/customer-directory';
export { CustomerDirectoryModule } from './customer-directory.module';
export { CheckoutModule } from './checkout.module';
export { CHECKOUT_RECOVERY_SCHEDULER, CheckoutRecoveryModule } from './checkout-recovery.module';
export { GrowthModule } from './growth.module';
export { CustomersModule } from './customers.module';
export { CustomersAccountsModule } from './customers-accounts.module';
export { CustomerMailModule } from './customer-mail.module';
export { CUSTOMER_MAIL_EVENTS } from './application/mail/customer-mail-outbox';
export type { CustomerMailKind } from './application/mail/customer-mail-outbox';
