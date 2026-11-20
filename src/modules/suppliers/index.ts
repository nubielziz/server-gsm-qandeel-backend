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
export { QuickAddRunner } from './application/quick-add-runner';
export { ANSWER_NOT_RECORDED_REASON, SupplierDispatch } from './application/supplier-dispatch';
export { DispatchRequests, RECENT_DISPATCH_REQUESTS } from './application/dispatch-requests';
export type { DispatchRequestInfo, DispatchRequestState } from './application/dispatch-requests';
export { DispatchSweep, EMPTY_SWEEP } from './application/dispatch-sweep';
export type { DispatchSweepResult, SweepItem, SweepPlan } from './application/dispatch-sweep';
export {
  DISPATCH_ANSWER_MARGIN_MS,
  DISPATCH_REQUEUE_AFTER_MS,
  DISPATCH_REQUEUE_MAX_AGE_MS,
  DISPATCH_SWEEP_BATCH,
  MAX_AUTOMATIC_REQUEUES,
  REQUEUED_MESSAGE,
  REQUEUE_LIMIT_REASON,
  REQUEUE_TOO_OLD_REASON,
  lostRequestAction,
} from './domain/dispatch-sweep-rules';
export type { LostRequestAction } from './domain/dispatch-sweep-rules';
export { DISPATCH_SWEEP_JOB, DispatchSweepProcessor } from './jobs/dispatch-sweep.processor';
export type { DispatchSweepData } from './jobs/dispatch-sweep.processor';
export { SupplierPoll } from './application/supplier-poll';
export { SupplierSync } from './application/supplier-sync';
export { SupplierJobsModule, SUPPLIER_SCHEDULERS } from './jobs/supplier-jobs.module';
export { SupplierEngineModule } from './supplier-engine.module';
export { SuppliersAdminModule } from './suppliers-admin.module';
export { SuppliersModule } from './suppliers.module';
