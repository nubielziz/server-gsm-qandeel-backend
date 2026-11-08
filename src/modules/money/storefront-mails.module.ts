// The module of the storefront customer emails (money module, feature 16): `StorefrontMails` together with the notification delivery it writes through.
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { StorefrontMails } from './application/storefront-mails';

/**
 * Provides {@link StorefrontMails} to the modules that report a storefront order, payment or refund by email.
 *
 * Why: `NotificationService` needs the database and the queue Redis (`NotificationDeliveryModule`), which the global, database-free
 * `MoneyModule` must not import, so the mails have a module of their own. The money admin routes, the order engine (API and worker) and the
 * checkout capture import it; a test app without a database leaves those out and this one with them.
 */
@Module({ imports: [NotificationDeliveryModule], providers: [StorefrontMails], exports: [StorefrontMails] })
export class StorefrontMailsModule {}
