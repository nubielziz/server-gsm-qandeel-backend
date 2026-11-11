// The module of the storefront customer emails (money module, features 16 and 21): `StorefrontMails` and `CustomerWalletMails` together with the
// notification delivery they write through.
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { CustomerWalletMails } from './application/customer-wallet-mails';
import { StorefrontMails } from './application/storefront-mails';

/**
 * Provides {@link StorefrontMails} and {@link CustomerWalletMails} to the modules that report a storefront order, payment or refund by email.
 *
 * Why: `NotificationService` needs the database and the queue Redis (`NotificationDeliveryModule`), which the global, database-free
 * `MoneyModule` must not import, so the mails have a module of their own. The money admin routes, the order engine (API and worker) and the
 * checkout capture import it; a test app without a database leaves those out and this one with them.
 */
@Module({
  imports: [NotificationDeliveryModule],
  providers: [StorefrontMails, CustomerWalletMails],
  exports: [StorefrontMails, CustomerWalletMails],
})
export class StorefrontMailsModule {}
