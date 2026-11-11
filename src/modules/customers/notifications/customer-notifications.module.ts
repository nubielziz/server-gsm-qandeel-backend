// The customers module's part of the notification center (feature 23): the customer audience provider, registered with the platform's
// registry at boot, and the hook that erases a customer's inbox on anonymization. Loaded by the API and the worker; DB-free at boot (both
// take a DbExecutor per call). The unsubscribe route, which needs the database, rides with `CustomersAccountsModule`.
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NotificationAudiences } from '../../platform';
import { CustomerErasureModule } from '../customer-erasure.module';
import { CustomerAudience } from './customer-audience';
import { CustomerInboxErasure } from './customer-inbox-erasure';

/**
 * Adds {@link CustomerAudience} to {@link NotificationAudiences}.
 *
 * Why: platform imports no module (decision 032): the owner of `customers` and `consent_records` registers.
 *
 * Side effects: registers one provider at boot.
 */
@Injectable()
export class CustomerAudienceRegistration implements OnModuleInit {
  constructor(
    private readonly audiences: NotificationAudiences,
    private readonly customers: CustomerAudience,
  ) {}

  /** Registers the provider. */
  onModuleInit(): void {
    this.audiences.register(this.customers);
  }
}

/**
 * Provides the customer audience provider and the erasure hook, and registers both.
 *
 * Why it imports {@link CustomerErasureModule}: the worker does not load the customers module, and a global module is only visible
 * when something in the application graph imports it.
 */
@Module({
  imports: [CustomerErasureModule],
  providers: [CustomerAudience, CustomerAudienceRegistration, CustomerInboxErasure],
})
export class CustomerNotificationsModule {}
