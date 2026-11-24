// Public API of the risk module: the IMEI mask and the visitor-country header reader other modules share, the services the payment, the
// checkout and the customer routes call (screening, blocklist, rules, data requests), the held-order decisions, the pure rules they share,
// and the modules. Other modules import only this file.
export { countryFromHeader } from './domain/visitor-country';
export { maskedImei, erasedMainInput } from './domain/imei-mask';
export { RISK_RULE_IDS } from './domain/risk-rules';
export type { RiskRuleId, RiskRuleSet } from './domain/risk-rules';
export { holdReason } from './domain/risk-scoring';
export { blockDisplay, blockHashInput, normalizeBlockValue } from './domain/blocklist-values';
export { Blocklist } from './application/blocklist';
export type { BlockHit, BlockProbeInput, BlockRequest } from './application/blocklist';
export { RiskScreening } from './application/risk-screening';
export type {
  ScreeningInput,
  ScreeningResult,
  TopUpScreening,
  TopUpScreeningInput,
} from './application/risk-screening';
export { RiskRules } from './application/risk-rules.service';
export { RiskDecisionsService } from './application/risk-decisions.service';
export { DataRequestService } from './application/data-request.service';
export { RiskServicesModule } from './risk-services.module';
export { RiskAdminModule } from './risk-admin.module';
export { RiskModule } from './risk.module';
