// Public surface of the contract layer (decision 008): defineRoute, defineSupplierCall, @Route, list queries, shared schemas, registry.
export {
  ACCESS_KINDS,
  ContractRegistry,
  DEFAULT_PENDING_MERCHANT_POLICY,
  DEFAULT_SESSION_STAGES,
  RANK_GATED_ACCESS_KINDS,
  SESSION_ACCESS_KINDS,
  SESSION_STAGES,
  TURNSTILE_ROLLOUTS,
  contractRegistry,
  declaredStatuses,
  defaultRankOf,
  defineRoute,
  isRankGatedAccess,
  isSessionAccess,
  parseRouteKey,
} from './define-route';
export type {
  AccessKind,
  AnyRouteContract,
  BodyOf,
  BodyType,
  HeadersOf,
  HttpMethod,
  ParamsOf,
  PendingMerchantPolicy,
  QueryOf,
  ResultOf,
  RouteContract,
  RouteKey,
  RouteRank,
  RouteSpec,
  SessionStage,
  SuccessSpec,
  SuccessStatus,
  TurnstileRollout,
} from './define-route';
export { SupplierCallRegistry, defineSupplierCall, supplierCallRegistry, zSupplierError } from './define-supplier-call';
export type {
  AnySupplierCall,
  SupplierCallContract,
  SupplierCallEntryOf,
  SupplierCallKey,
  SupplierCallParamsOf,
  SupplierCallSpec,
} from './define-supplier-call';
export {
  FORBIDDEN_TEXT_CODE,
  FORBIDDEN_TEXT_DHRU_MESSAGE,
  FORBIDDEN_TEXT_MESSAGE,
  forbiddenTextPathOf,
  withoutForbiddenText,
} from './forbidden-characters';
export { toJsonSchema } from './json-schema';
export type { JsonSchema } from './json-schema';
export {
  DEFAULT_MAX_PAGE,
  DEFAULT_PAGE_SIZE,
  describeListQuery,
  isListQuerySchema,
  listQuery,
  listQueryParameters,
  withoutSearchFields,
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
export {
  MAX_ID,
  zDateOnly,
  zDecimal,
  zId,
  zIdParam,
  zIsoDateTime,
  zJsonObject,
  zMoney,
  zSignedMoney,
  zUploadedFile,
} from './zod';
export type { JsonObject, JsonValue } from './zod';
