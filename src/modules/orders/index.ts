// Public API of the orders module: the state machine (pure rules), the past-SLA predicate (the dashboard and System health use it), the
// placement and transition services the Dhru, supplier and risk features call, the outbox event types, and the modules.
// Other modules import only this file.
// Order matters (decision 032): the pure rules and SQL fragments come first, ahead of the modules whose providers lead into identity.
// The door an order came through (paid first or held from the wallet) and the read of an account's shop orders (decision 064).
export { isPrepaidOrder, prepaidOrderSql } from './domain/door';
export { ShopOrders } from './ports/shop-orders';
export type { ShopOrderPage, ShopOrderRow } from './ports/shop-orders';
export {
  WIRE_DISPATCH_STATES,
  decideOrderAction,
  deriveQueue,
  isOpen,
  orderStateOf,
  placementDispatchState,
  wireDispatchState,
  PAYMENT_STOP_REASONS,
} from './domain/order-machine';
export type {
  OrderAction,
  OrderDecision,
  OrderMoneyMove,
  OrderQueue,
  OrderRefusal,
  OrderState,
  OrderTransition,
  PaymentStop,
  WireDispatchState,
} from './domain/order-machine';
export { mainInputOf, typedImeiOf } from './domain/main-input';
export { MAX_INPUT_LENGTH, inputProblems, isValidImei, normalizeImei, quantityProblem } from './domain/placement-rules';
export type { PlacementField, QuantityRules } from './domain/placement-rules';
export type { MainInputField, MainInputSource, TypedImei } from './domain/main-input';
export { channelSql, pastSlaPredicate, queueSql } from './infra/order-sql';
export { rewriteCustomerOrderInputs } from './infra/order.repository';
export type { CustomerOrderInputs } from './infra/order.repository';
// The slot the customers module fills at boot (whether an order's customer was anonymized); a leaf with no module imports.
export { TrackingCustomerPorts } from './application/tracking-customer-port';
export type { TrackingCustomerPort } from './application/tracking-customer-port';
export {
  ORDER_DISPATCH_STATES,
  ORDER_EVENT_ACTOR_TYPES,
  ORDER_EVENT_TYPES,
  ORDER_SOURCES,
  ORDER_STATUSES,
  ORDER_VERIFICATION_STATUSES,
} from './db/schema';
export type {
  Order,
  OrderDispatchState,
  OrderEvent,
  OrderEventActorType,
  OrderEventType,
  OrderSource,
  OrderStatus,
  OrderVerificationStatus,
} from './db/schema';
export { ORDER_OUTBOX_EVENTS, OrderOutbox } from './application/order-outbox';
export type { StatusChangedPayload } from './application/order-outbox';
export { OrderPlacement } from './application/order-placement';
export type { PlacementItem, PlacementRequest } from './application/order-placement';
export { CustomerOrderPlacement } from './application/customer-placement';
export type { CustomerPlacementRequest } from './application/customer-placement';
export {
  CHANGED_FIRST_DETAIL,
  OrderTransitions,
  SEND_IN_PROGRESS_DETAIL,
  refusalError,
} from './application/order-transitions';
export type { TransitionOutcome, TransitionRequest } from './application/order-transitions';
export type { LedgerActor } from './application/order-ledger';
export { OrderReadService } from './application/order-read.service';
export { OrderSupplierMoves } from './application/order-supplier-moves';
export type {
  EventData,
  LateAcceptance,
  LateAcceptanceCause,
  SupplierMove,
  SupplierMoveAction,
  SupplierSettlement,
} from './application/order-supplier-moves';
export type {
  PollCandidate,
  SupplierOrderCounts,
  SupplierOrderUsage,
  UnansweredClaim,
  UnclaimedOrder,
} from './infra/order-supplier.repository';
export { OrdersOutboxModule } from './orders-outbox.module';
// The one-off seal pass of the tracking tokens stored as issued (decision 054); its module is loaded by the worker only.
export {
  TRACKING_TOKENS_SEAL_EVENT,
  TRACKING_TOKENS_SEAL_JOB,
  TrackingTokenSeal,
} from './application/tracking-token-seal';
export { TrackingTokenSealModule } from './jobs/tracking-token-seal.module';
export { IdempotencyPurge, IDEMPOTENCY_PURGE_BATCH_SIZE } from './jobs/idempotency-purge';
export type { IdempotencyPurgeCount } from './jobs/idempotency-purge';
export { IdempotencyPurgeModule, IDEMPOTENCY_PURGE_SCHEDULER } from './jobs/idempotency-purge.module';
export { IDEMPOTENCY_PURGE_JOB, IdempotencyPurgeProcessor } from './jobs/idempotency-purge.processor';
export { IDEMPOTENCY_WINDOW_DAYS } from './domain/idempotency-window';
export { OrdersEngineModule } from './orders-engine.module';
export { OrdersAdminModule } from './orders-admin.module';
export { OrderTrackingModule } from './order-tracking.module';
export { OrdersModule } from './orders.module';
