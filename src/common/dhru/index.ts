// Public surface of src/common/dhru: the action contracts and their registry, the gateway the modules bind handlers to, and the
// helpers of the Dhru wire format (decision 026).
export { DhruActionRegistry, defineDhruAction, dhruActionRegistry } from './define-dhru-action';
export type {
  AnyDhruAction,
  DhruActionContract,
  DhruActionKey,
  DhruActionSpec,
  DhruParamsOf,
  DhruResultOf,
} from './define-dhru-action';
export {
  DHRU_BULK_PLACEMENT_ACTION,
  DHRU_MAX_BULK_ITEMS,
  DHRU_MAX_ITEM_ID_LENGTH,
  DhruGateway,
  bulkPlacementItems,
} from './dhru-gateway';
export type { DhruCall, DhruCaller, DhruExecution, DhruHandler } from './dhru-gateway';
export {
  DHRU_HEADERS,
  decodeBase64Object,
  dhruBulk,
  dhruError,
  dhruStatusOf,
  dhruSuccess,
  readCustomFields,
  readParameters,
} from './dhru-envelope';
export type { DhruItemAnswer } from './dhru-envelope';
export { DhruModule } from './dhru.module';
export { supplierFieldName } from './main-input-key';
