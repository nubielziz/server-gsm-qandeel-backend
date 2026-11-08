// The commission engine without any route: it registers with the order completion hook, so the API (staff replies, stock deliveries) and the
// worker (supplier results settle orders there) both accrue and reverse commissions in the order's own transaction.
import { Module } from '@nestjs/common';
import { LedgerPoster, WalletLowBalanceWatch } from '../money';
import { OrderCompletionModule } from '../orders';
import { CommissionAccruals } from './application/commission-accruals';

/**
 * Provides {@link CommissionAccruals} (and the ledger writer its reversals need) without controllers.
 *
 * Why: feature 11 and decision 020: an order completes in either process, so the listener must be loaded by both; the worker never
 * loads the API's route modules. The ledger classes are stateless and take the caller's transaction, so building them here costs
 * nothing (the same choice as `OrdersEngineModule`); the clock, outbox and database providers come from the global modules.
 */
@Module({
  imports: [OrderCompletionModule],
  providers: [LedgerPoster, WalletLowBalanceWatch, CommissionAccruals],
  exports: [CommissionAccruals],
})
export class CommissionsEngineModule {}
