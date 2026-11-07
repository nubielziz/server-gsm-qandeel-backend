// The money routes of stage 3 (wallets, statements, adjustments, credit limits, the ledger screens, reconciliation and
// currencies) with the services behind them. Separate from MoneyModule so a test app built without a database can leave
// it out while MerchantAccounts and LedgerPoster stay available.
import { Module } from '@nestjs/common';
import { JobRunsModule } from '../health';
import { CurrencyService } from './application/currency.service';
import { LedgerReadService } from './application/ledger-read.service';
import { MerchantApiAccount } from './application/merchant-api-account';
import { ReconcileService } from './application/reconcile.service';
import { TaxRateService } from './application/tax-rate.service';
import { WalletService } from './application/wallet.service';
import { CurrenciesController } from './controllers/currencies.controller';
import { LedgerController } from './controllers/ledger.controller';
import { TaxRatesController } from './controllers/tax-rates.controller';
import { V1AccountController } from './controllers/v1-account.controller';
import { WalletController } from './controllers/wallet.controller';

/**
 * Provides `/admin/clients/:id/wallet|statement|wallet/adjust|credit-limit`, `/admin/ledger/*`, `/admin/currencies`,
 * `/admin/tax-rates`, the merchant's own `/client/wallet` routes and the account reads of REST v1 and Dhru (`/v1/account`,
 * `/v1/transactions`, `accountinfo`).
 *
 * Why: these use cases need the global database, audit, settings and clock providers (and `job_runs` for reconciliation),
 * which a database-less test app does not have; `MerchantAccounts` and `LedgerPoster` (the global `MoneyModule`) need none
 * of them. `WalletService` is exported for the later order, billing and refund features.
 */
@Module({
  imports: [JobRunsModule],
  controllers: [WalletController, LedgerController, CurrenciesController, TaxRatesController, V1AccountController],
  providers: [WalletService, LedgerReadService, ReconcileService, CurrencyService, TaxRateService, MerchantApiAccount],
  exports: [WalletService],
})
export class MoneyAdminModule {}
