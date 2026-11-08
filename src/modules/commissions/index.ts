// Public API of the commissions module: the modules (the API's routes and use cases, and the engine the worker loads to accrue
// commissions when orders complete) and the rule constants other features read. Other modules import only this file.
// Order matters (decision 032): the pure rules come first, ahead of the modules whose providers lead into identity.
export { MAX_PLAN_PERCENT, MIN_PLAN_PERCENT } from './domain/plan-input';
export { COMMISSION_ACCRUAL_STATUSES, COMMISSION_PLAN_KINDS } from './db/schema';
export type { CommissionAccrualStatus, CommissionPlanKind } from './db/schema';
export { CommissionsEngineModule } from './commissions-engine.module';
export { CommissionsAdminModule } from './commissions-admin.module';
export { CommissionsModule } from './commissions.module';
