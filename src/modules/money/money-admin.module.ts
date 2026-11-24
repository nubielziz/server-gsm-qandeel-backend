// The money routes of stage 3 (wallets, statements, adjustments, credit limits, the ledger screens, reconciliation and
// currencies) with the services behind them. Separate from MoneyModule so a test app built without a database can leave
// it out while MerchantAccounts and LedgerPoster stay available.
import { Module } from '@nestjs/common';
import { JobRunsModule } from '../health';
import { ClientGroupDirectory } from '../catalog';
import { StoredFiles } from '../platform';
import { AccountRankChange } from './application/account-rank-change.service';
import { AccountWalletAdmin } from './application/account-wallet-admin';
import { ClientStatementService } from './application/client-statement.service';
import { CurrencyService } from './application/currency.service';
import { FxRefreshService } from './application/fx-refresh.service';
import { GatewayCredentialsVault } from './application/gateway-credentials';
import { InvoiceAdminService } from './application/invoice-admin.service';
import { InvoiceDocuments } from './application/invoice-documents';
import { MerchantBillingService } from './application/merchant-billing.service';
import { PaymentCrediting } from './application/payment-crediting';
import { PaymentGatewayService } from './application/payment-gateway.service';
import { PaymentReviewService } from './application/payment-review.service';
import { PaymentViews } from './application/payment-views';
import { PaymentWebhookService } from './application/payment-webhook.service';
import { PaymentWebhookVerifier } from './application/payment-webhook-verifier';
import { LedgerReadService } from './application/ledger-read.service';
import { MerchantApiAccount } from './application/merchant-api-account';
import { B2cReportsService } from './application/b2c-reports.service';
import { DisputeLedger } from './application/dispute-ledger';
import { DisputeService } from './application/dispute.service';
import { DisputeViews } from './application/dispute-views';
import { DisputeWebhookService } from './application/dispute-webhook.service';
import { HeldPaymentsService } from './application/held-payments.service';
import { OrderReceipts } from './application/order-receipts';
import { ReceiptBuyerPorts } from './application/storefront-ports';
import { RefundService } from './application/refund.service';
import { RefundSettlement } from './application/refund-settlement';
import { RefundViews } from './application/refund-views';
import { StorefrontPayments } from './application/storefront-payments';
import { ReconcileService } from './application/reconcile.service';
import { ReportService } from './application/report.service';
import { TaxRateService } from './application/tax-rate.service';
import { WalletService } from './application/wallet.service';
import { AccountRankController } from './controllers/account-rank.controller';
import { B2cReportsController } from './controllers/b2c-reports.controller';
import { ClientBillingController } from './controllers/client-billing.controller';
import { CurrenciesController } from './controllers/currencies.controller';
import { DisputesController } from './controllers/disputes.controller';
import { GatewaysController } from './controllers/gateways.controller';
import { HeldPaymentsController } from './controllers/held-payments.controller';
import { InvoicesController } from './controllers/invoices.controller';
import { FxController } from './controllers/fx.controller';
import { LedgerController } from './controllers/ledger.controller';
import { ReportsController } from './controllers/reports.controller';
import { PaymentWebhookController } from './controllers/payment-webhook.controller';
import { PaymentsController } from './controllers/payments.controller';
import { RefundsController } from './controllers/refunds.controller';
import { TaxRatesController } from './controllers/tax-rates.controller';
import { WalletController } from './controllers/wallet.controller';
import { FX_PROVIDER_FACTORY } from './infra/fx-provider.factory';
import { MoneyOutboxModule } from './money-outbox.module';
import { CustomerTopUps } from './application/customer-top-ups';
import { CustomerWalletPayments } from './application/customer-wallet-payments';
import { CustomerWallets } from './application/customer-wallets';
import { CustomerTopUpsController } from './controllers/customer-topups.controller';
import { CustomerWalletController } from './controllers/customer-wallet.controller';
import { TopUpScreeningModule } from './top-up-screening.module';
import { StorefrontMailsModule } from './storefront-mails.module';
import { WalletErasure } from './ports/wallet-erasure';

/**
 * Provides `/admin/clients/:id/wallet|statement|wallet/adjust|credit-limit`, `/admin/ledger/*`, `/admin/currencies`,
 * `/admin/tax-rates`, the reports `/admin/reports/profit|wallet-exposure|suppliers|top-clients|client-statement/:clientId`, the merchant's own `/client/wallet`
 * routes, the account read of Dhru (`accountinfo`) and the billing of stage 8:
 * `/admin/payment-gateways`, `/admin/invoices`, `/admin/payments`, the portal's `/client/payment-methods` and `/client/invoices`,
 * and the incoming `POST /webhooks/payments/:gateway` with the gateway signature adapters behind it, and the storefront money of
 * stage 16: `/admin/refunds`, `/admin/disputes`, `/admin/reports/vat|payments` and `POST /webhooks/disputes/:gateway`, and the close of a
 * storefront payment held for staff (`POST /admin/held-payments/:id/close`, decision 048); it exports
 * what the checkout and the order receipt need (`StorefrontPayments`, `OrderReceipts`); and the customer wallet of feature 21
 * (`/store/v1/me/wallet*` with the top-ups, `/admin/customer-wallets`; the retired `/admin/customers/:id/wallet*` answer 410), exporting
 * `CustomerWallets` and `CustomerWalletPayments` for the customers module (data export, balance payment). Decision 064 adds the staff
 * wallet of either kind (`AccountWalletAdmin` behind `/admin/clients/:id/wallet*`) and the rank change (`POST /admin/clients/:id/rank`,
 * `AccountRankChange`), and binds `WalletErasure` to `CustomerWallets` (exported: the customers module's anonymize asks it).
 *
 * Why: these use cases need the global database, audit, settings and clock providers (and `job_runs` for reconciliation),
 * which a database-less test app does not have; `MerchantAccounts` and `LedgerPoster` (the global `MoneyModule`) need none
 * of them. `WalletService` is exported for the later order, billing and refund features.
 */
@Module({
  imports: [JobRunsModule, MoneyOutboxModule, StorefrontMailsModule, TopUpScreeningModule],
  controllers: [
    WalletController,
    LedgerController,
    CurrenciesController,
    TaxRatesController,
    FxController,
    GatewaysController,
    InvoicesController,
    PaymentsController,
    ClientBillingController,
    PaymentWebhookController,
    ReportsController,
    RefundsController,
    HeldPaymentsController,
    DisputesController,
    B2cReportsController,
    CustomerWalletController,
    CustomerTopUpsController,
    AccountRankController,
  ],
  providers: [
    WalletService,
    LedgerReadService,
    ReconcileService,
    CurrencyService,
    TaxRateService,
    MerchantApiAccount,
    ClientGroupDirectory,
    StoredFiles,
    GatewayCredentialsVault,
    PaymentGatewayService,
    InvoiceDocuments,
    InvoiceAdminService,
    PaymentViews,
    PaymentCrediting,
    PaymentReviewService,
    MerchantBillingService,
    PaymentWebhookService,
    PaymentWebhookVerifier,
    FxRefreshService,
    // Decision 029: the driver named by FX_PROVIDER; `openexchangerates` without a key behaves like `manual` (502 on refresh).
    FX_PROVIDER_FACTORY,
    ReportService,
    ClientStatementService,
    StorefrontPayments,
    OrderReceipts,
    // The customers module fills it (decision 032): whom a receipt names.
    ReceiptBuyerPorts,
    RefundViews,
    RefundService,
    RefundSettlement,
    HeldPaymentsService,
    DisputeViews,
    DisputeLedger,
    DisputeService,
    DisputeWebhookService,
    B2cReportsService,
    CustomerWallets,
    CustomerTopUps,
    CustomerWalletPayments,
    { provide: WalletErasure, useExisting: CustomerWallets },
    AccountWalletAdmin,
    AccountRankChange,
  ],
  exports: [WalletService, StorefrontPayments, OrderReceipts, CustomerWallets, CustomerWalletPayments, WalletErasure],
})
export class MoneyAdminModule {}
