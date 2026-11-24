// Root module of the worker process (decision 016): config, the clock (decision 031), logging, metrics, the infrastructure (database, Redis, cache,
// rate limits, crypto, storage, outbound HTTP, the real-time doorbell publisher of decision 037), the queue workers and schedulers, the outbox relay, job runs, the IP rule
// hit flush, the ended-session purge, the merchant mail jobs (verification, reset and invitation links), the automatic credit of top-ups (`payment_auto_credit`, with the `invoice.paid` outbox route), the order outbox route (`order.dispatch_requested` to the supplier dispatch job), the notifications (event routes, planning and sending processors, feature 12a), the customer mail jobs (sign-in, reset, invitation and verification links, feature 14b), the hourly exchange-rate refresh (`fx_refresh`), the storefront refunds sent to their gateways (`refund.process`), the storefront receipts drawn and stored (`receipt.render`, with the customers module's directory that says whom a receipt names), the price change scan, the supplier jobs (dispatch, poll, sync), the health jobs (component checks, purge, reaper, size sample), the support ticket mails (receipt, reply), the support chat's jobs (the reply-mail sweep every minute and the nightly attachment retention, feature 28), the platform's daily clean-up (`upload_janitor`, decision 053; the supplier call log's `supplier_log_retention` is in the supplier jobs), the daily Idempotency-Key purge (`idempotency_purge`, P4a), the risk services (they register the top-up question the automatic credit asks, RESOLUTIONS money-3), the storefront search jobs (the `search-index` queue's sync and settings push, the reconcile, rebuild, terms build, flush and purge, with the search engine client on the worker's indexer key; feature 29), the bulk publish's apply and run switch (`publish_apply`, `publish_set_listed` on `imports`; feature 31), the retail price follow pass (`retail_price_follow`; feature 31), the one-off seal passes of the shop's link tokens (`checkout_tokens_seal`, `tracking_tokens_seal`, `ticket_tokens_seal`; decision 054), the lost-work reconcile and the outbox purge (decision 055) and the metrics listener. The boot checks of the database role (decision 055) and of LOOKUP_HASH_KEY (decision 054) run before any worker starts. Domain modules add their processors and schedules here as their features are built.
import { Module, type OnModuleInit } from '@nestjs/common';
import { ClockModule } from './common/clock.module';
import { ConfigModule } from './config';
import { CacheModule } from './infra/cache';
import { CryptoModule } from './infra/crypto';
import { DatabaseRoleCheckModule, DbModule } from './infra/db';
import { OutboundHttpModule } from './infra/http';
import { LoggingModule } from './infra/logging';
import { MetricsModule, WorkerMetricsServer } from './infra/metrics';
import { JobSchedulerRegistry, QueueWorkersModule, QueuesModule } from './infra/queues';
import { RateLimitModule } from './infra/rate-limit';
import { RealtimeModule } from './infra/realtime';
import { RedisModule } from './infra/redis';
import { SearchModule } from './infra/search';
import { StorageModule } from './infra/storage';
import {
  CategoryNameCleanupModule,
  FieldPatternReviewModule,
  PriceChangeScanModule,
  RetailPriceFollowModule,
} from './modules/catalog';
import {
  CheckoutTokenSealModule,
  CustomerDirectoryModule,
  CustomerMailModule,
  CustomerNotificationsModule,
} from './modules/customers';
import { HealthJobsModule, JobRunsModule } from './modules/health';
import {
  IdentityAudienceModule,
  IpRuleHitsFlushModule,
  MerchantMailModule,
  SessionPurgeModule,
  StaffMailModule,
} from './modules/identity';
import { FxRefreshJobModule, PaymentAutoCreditModule, ReceiptRenderModule, RefundProcessModule } from './modules/money';
import { IdempotencyPurgeModule, OrdersOutboxModule, TrackingTokenSealModule } from './modules/orders';
import {
  LookupKeyCheckModule,
  LostWorkModule,
  MailHealthProbeModule,
  NotificationDeliveryModule,
  NotificationEventsModule,
  OutboxRelayModule,
  PlatformRetentionModule,
} from './modules/platform';
import { RiskServicesModule } from './modules/risk';
import { PublishWorkerModule, SearchWorkerModule, StorefrontPopularityModule } from './modules/storefront';
import { SupplierJobsModule } from './modules/suppliers';
import { SupportEventsModule, SupportJobsModule, SupportMailModule, TicketTokenSealModule } from './modules/support';

/**
 * Root Nest module of the worker process.
 *
 * Why: the worker shares the codebase with the API but never serves the API's routes. It runs the BullMQ workers for
 * every `@QueueProcessor`, creates the job schedulers on boot, relays the outbox (decision 020), and exposes its own
 * `/metrics` on `WORKER_METRICS_PORT` so Prometheus can scrape queue and job metrics (decision 015). Shutdown order
 * (decision 001): workers and the relay stop in `onModuleDestroy`; the pool, Redis and the producers close afterwards. The schedulers of
 * jobs that no longer exist are listed as retired here, so the worker removes them from Redis at boot (`JobSchedulerRegistry.retire`).
 */
@Module({
  imports: [
    ConfigModule,
    ClockModule,
    LoggingModule.forRoot({ service: 'worker' }),
    MetricsModule,
    DbModule,
    DatabaseRoleCheckModule,
    RedisModule,
    CacheModule,
    RateLimitModule,
    CryptoModule,
    StorageModule,
    OutboundHttpModule,
    SearchModule.forRoot({ role: 'indexer' }),
    QueuesModule,
    QueueWorkersModule,
    RealtimeModule,
    JobRunsModule,
    LookupKeyCheckModule,
    OutboxRelayModule,
    LostWorkModule,
    PlatformRetentionModule,
    IpRuleHitsFlushModule,
    SessionPurgeModule,
    MerchantMailModule,
    StaffMailModule,
    CustomerMailModule,
    OrdersOutboxModule,
    IdempotencyPurgeModule,
    StorefrontPopularityModule,
    SearchWorkerModule,
    PublishWorkerModule,
    NotificationEventsModule,
    NotificationDeliveryModule,
    MailHealthProbeModule,
    PriceChangeScanModule,
    RetailPriceFollowModule,
    CategoryNameCleanupModule,
    FieldPatternReviewModule,
    CheckoutTokenSealModule,
    TrackingTokenSealModule,
    TicketTokenSealModule,
    PaymentAutoCreditModule,
    FxRefreshJobModule,
    RefundProcessModule,
    ReceiptRenderModule,
    // Whom a receipt names: the customers module's directory fills money's slot at boot.
    CustomerDirectoryModule,
    SupplierJobsModule,
    HealthJobsModule,
    SupportEventsModule,
    SupportMailModule,
    SupportJobsModule,
    RiskServicesModule,
    IdentityAudienceModule,
    CustomerNotificationsModule,
  ],
  providers: [WorkerMetricsServer],
})
export class WorkerModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /**
   * Lists the schedulers of retired jobs; the worker's scheduler runner removes them from Redis when it starts.
   *
   * Why: upserting never deletes, so the nightly erasure of old IMEI checks (`data-retention` on `maintenance`, 03:00 UTC) would keep
   * creating jobs that no processor takes after the free IMEI check was retired. Keep the line until every environment has booted a worker
   * once.
   */
  onModuleInit(): void {
    this.schedulers.retire('maintenance', 'data-retention');
  }
}
