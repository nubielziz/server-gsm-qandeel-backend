// Nest module of the automatic top-up credit (money module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { AuditService, PdfModule, StoredFiles } from '../../platform';
import { GatewayCredentialsVault } from '../application/gateway-credentials';
import { InvoiceDocuments } from '../application/invoice-documents';
import { PaymentCrediting } from '../application/payment-crediting';
import { LedgerPoster } from '../application/post-transaction';
import { WalletLowBalanceWatch } from '../application/wallet-low-balance-watch';
import { MoneyOutboxModule } from '../money-outbox.module';
import { TopUpScreeningModule } from '../top-up-screening.module';
import { PaymentAutoCredit } from './payment-auto-credit';
import { PAYMENT_AUTO_CREDIT_JOB, PaymentAutoCreditProcessor } from './payment-auto-credit.processor';

/**
 * The id of the scheduler that ticks the automatic credit every minute.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const PAYMENT_AUTO_CREDIT_SCHEDULER = 'payment-auto-credit';

/**
 * Provides the automatic credit, its processor, and registers its schedule (every minute).
 *
 * Why: the API never does slow work inline (decision 020); the worker does. The classes the job needs are plain services, so the
 * worker builds them here instead of loading the API's modules (the ledger writer, the audit writer, the invoice PDF). The outbox
 * route of `invoice.paid` comes with {@link MoneyOutboxModule}. {@link TopUpScreeningModule} is the list of risk hooks the credit
 * asks (RESOLUTIONS money-3); the risk services module fills it, and the worker loads both.
 */
@Module({
  imports: [JobRunsModule, MoneyOutboxModule, PdfModule, TopUpScreeningModule],
  providers: [
    LedgerPoster,
    WalletLowBalanceWatch,
    AuditService,
    StoredFiles,
    InvoiceDocuments,
    GatewayCredentialsVault,
    PaymentCrediting,
    PaymentAutoCredit,
    PaymentAutoCreditProcessor,
  ],
  exports: [PaymentAutoCredit],
})
export class PaymentAutoCreditModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: PAYMENT_AUTO_CREDIT_SCHEDULER,
      queue: 'maintenance',
      jobName: PAYMENT_AUTO_CREDIT_JOB,
      pattern: '* * * * *',
      description:
        'Credits the wallet of top-ups that automatic gateways confirmed, after the delay and a new gateway check.',
    });
  }
}
