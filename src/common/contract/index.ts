// Public surface of the contract layer (decision 008): defineRoute, @Route, list queries, shared schemas, registry.
export { ContractRegistry, contractRegistry, declaredStatuses, defineRoute, parseRouteKey } from './define-route';
export type {
  AccessKind,
  AnyRouteContract,
  BodyOf,
  HeadersOf,
  HttpMethod,
  ParamsOf,
  QueryOf,
  ResultOf,
  RouteContract,
  RouteKey,
  RouteSpec,
  SuccessSpec,
  SuccessStatus,
} from './define-route';
export { EventRegistry, defineEvent, eventRegistry } from './define-event';
export type { EventContract, EventKey, EventSpec } from './define-event';
export { toJsonSchema } from './json-schema';
export type { JsonSchema } from './json-schema';
export {
  DEFAULT_MAX_PAGE,
  DEFAULT_PAGE_SIZE,
  describeListQuery,
  isListQuerySchema,
  listQuery,
  listQueryParameters,
} from './list-query';
export type {
  FilterOp,
  FilterSpec,
  FilterType,
  FilterValue,
  ListQueryConfig,
  ListQueryDescriptor,
  ListQuerySchema,
  ListSort,
  ParsedFilter,
  ParsedListQuery,
} from './list-query';
export { SECURITY_SCHEME, buildOperation, openApiDecorators, operationIdOf } from './openapi';
export type { OperationParts } from './openapi';
export { respondWith } from './respond-with';
export { CONTRACT_METADATA, ContractHeaders, Route, getContract } from './route.decorator';
export { ContractResponseInterceptor, shapeResponse } from './response.interceptor';
export {
  ContractInputGuard,
  ContractValidationPipe,
  toFieldErrors,
  validateInputs,
  validationFailed,
} from './validation.pipe';
export { MAX_ID, zDateOnly, zDecimal, zId, zIdParam, zIsoDateTime, zJsonObject, zMoney } from './zod';
export type { JsonObject, JsonValue } from './zod';
