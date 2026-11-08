// The module that owns the one list of top-up screening hooks (feature 18): a leaf with no dependencies, so the risk module can
// register its hook and the automatic credit can ask it without either importing the other's internals.
import { Module } from '@nestjs/common';
import { TopUpScreeningHooks } from './application/top-up-screening-hooks';

/**
 * Provides {@link TopUpScreeningHooks}.
 *
 * Why: Nest builds one instance per module class, so every module that imports this one shares the same list. The credit job's
 * module (`PaymentAutoCreditModule`) and the risk services module (`RiskServicesModule`) both import it. It needs nothing, so a
 * test app built without a database can load it.
 */
@Module({ providers: [TopUpScreeningHooks], exports: [TopUpScreeningHooks] })
export class TopUpScreeningModule {}
