// The risk module's services that other modules call (feature 18): the blocklist, the rules, the payment screening, the decisions on
// held orders, the IMEI erasure and the data requests. No controllers, so any module can import it.
import { Module, type OnModuleInit } from '@nestjs/common';
import { TopUpScreeningHooks, TopUpScreeningModule } from '../money';
import { OrdersEngineModule } from '../orders';
import { AuditService, SettingsModule } from '../platform';
import { Blocklist } from './application/blocklist';
import { DataRequestService } from './application/data-request.service';
import { ImeiErasure } from './application/imei-erasure';
import { RiskDecisionsService } from './application/risk-decisions.service';
import { RiskRules } from './application/risk-rules.service';
import { RiskScreening } from './application/risk-screening';

/**
 * Provides the public services of the risk module.
 *
 * Why: the storefront payment screens a payment (`RiskScreening`) and refunds one the rules block (`RiskDecisionsService`, which moves
 * the order through the order engine), the checkout asks the `Blocklist`, the customer block and the anonymization call `Blocklist`,
 * `ImeiErasure` and `DataRequestService`. They need the global database, crypto and clock
 * providers, which a database-less test app does not have, so the modules that import this one are among the modules that app
 * leaves out. The worker loads it too (RESOLUTIONS money-3): it registers the top-up question with the money module's hook list, so
 * the automatic credit never credits a top-up that the blocklist flags. The worker has no global audit module, so the audit
 * writer is provided here like the other worker-side modules do (it holds no state).
 */
@Module({
  imports: [SettingsModule, TopUpScreeningModule, OrdersEngineModule],
  providers: [Blocklist, RiskRules, RiskScreening, RiskDecisionsService, ImeiErasure, DataRequestService, AuditService],
  exports: [Blocklist, RiskRules, RiskScreening, RiskDecisionsService, ImeiErasure, DataRequestService],
})
export class RiskServicesModule implements OnModuleInit {
  constructor(
    private readonly screening: RiskScreening,
    private readonly topUps: TopUpScreeningHooks,
  ) {}

  /** Tells the money module's automatic credit to ask {@link RiskScreening.reviewTopUp} before it credits a top-up. */
  onModuleInit(): void {
    this.topUps.add({
      screenTopUp: (db, facts) =>
        this.screening.reviewTopUp(db, { email: facts.email, cardFingerprint: facts.cardFingerprint }),
    });
  }
}
