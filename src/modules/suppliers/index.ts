// Public API of the suppliers module: the supplier directory and reader (other modules and the system health view use them), the health
// rules (feature 9 reuses them), the test policy token, and the modules. Other modules import only this file.
// Order matters (decision 032): the pure rules and tokens come first, ahead of the modules whose providers lead into identity.
export {
  CHECK_MAX_AGE_MS,
  DEGRADED_FAILURE_PERCENT,
  DOWN_FAILURE_PERCENT,
  healthFromCalls,
  isLowBalance,
  runwayDays,
  supplierHealth,
  toPageHealth,
} from './domain/supplier-health';
export type { CallCounts, LatestCheck, SupplierHealthWord, SupplierPageHealth } from './domain/supplier-health';
export { linkUnitCost, pickLink } from './domain/link-selection';
export type { LinkChoice, RoutingLink } from './domain/link-selection';
export { SUPPLIER_CALLS } from './contracts/supplier-calls.contracts';
export { SUPPLIER_CALL_OUTCOMES, SUPPLIER_DRIVERS, SUPPLIER_PARAM_FORMATS, SUPPLIER_STATUSES } from './db/schema';
export type { Supplier, SupplierCallOutcome, SupplierDriver, SupplierParamFormat, SupplierStatus } from './db/schema';
export { SUPPLIER_PLAIN_HTTP_KEY, SUPPLIER_TARGET_POLICY } from './application/supplier-target-policy';
export type { SupplierTargetPolicy } from './application/supplier-target-policy';
export { SupplierDirectory } from './application/supplier-directory';
export type { SupplierRef } from './application/supplier-directory';
export { SupplierReader } from './application/supplier-reader';
export type { SupplierDetailView, SupplierView } from './application/supplier-reader';
export { SupplierDispatch } from './application/supplier-dispatch';
export { SupplierPoll } from './application/supplier-poll';
export { SupplierSync } from './application/supplier-sync';
export { SupplierJobsModule, SUPPLIER_SCHEDULERS } from './jobs/supplier-jobs.module';
export { SupplierEngineModule } from './supplier-engine.module';
export { SuppliersAdminModule } from './suppliers-admin.module';
export { SuppliersModule } from './suppliers.module';
