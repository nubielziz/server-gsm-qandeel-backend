// Public API of the orders module: the state machine (pure rules), the past-SLA predicate (the dashboard and System health use it), the
// placement and transition services the Dhru, REST v1, supplier and risk features call, the outbox event types, and the modules.
// Other modules import only this file.
// Order matters (decision 032): the pure rules and SQL fragments come first, ahead of the modules whose providers lead into identity.
export { decideOrderAction, deriveQueue, isOpen, placementDispatchState } from './domain/order-machine';
export type {
  OrderAction,
  OrderDecision,
  OrderMoneyMove,
  OrderQueue,
  OrderRefusal,
  OrderState,
  OrderTransition,
} from './domain/order-machine';
export { mainInputOf } from './domain/main-input';
export type { MainInputField, MainInputSource } from './domain/main-input';
export { channelSql, pastSlaPredicate, queueSql } from './infra/order-sql';
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
export { OrderTransitions, refusalError } from './application/order-transitions';
export type { TransitionOutcome, TransitionRequest } from './application/order-transitions';
export { OrderReadService } from './application/order-read.service';
export { OrdersOutboxModule } from './orders-outbox.module';
export { OrdersAdminModule } from './orders-admin.module';
export { OrdersModule } from './orders.module';
