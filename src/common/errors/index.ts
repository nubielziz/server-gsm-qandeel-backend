// Public surface of src/common/errors: the catalog, AppError, the problem document, the filter and its module.
export { AlternateResponse } from './alternate-response';
export { AppError } from './app-error';
export type { AppErrorOptions, FieldError } from './app-error';
export { ERROR_CATALOG, isErrorCode, problemSlug, statusOf, titleOf } from './catalog';
export type { ErrorCatalogEntry, ErrorCode } from './catalog';
export { ProblemExceptionFilter } from './exception.filter';
export { ErrorsModule } from './errors.module';
export { DHRU_API_VERSION, DhruErrorFormatter, dhruMessageOf } from './dhru-formatter';
export { ErrorFormatterRegistry } from './formatter-registry';
export type { ErrorFormatContext, ErrorFormatter, ErrorResponse } from './formatter-registry';
export { codeForStatus, normalizeException } from './normalize-exception';
export type { NormalizedException } from './normalize-exception';
export { PROBLEM_CONTENT_TYPE, buildProblem, recalledProblemCode, rememberProblemCode } from './problem';
export type { ProblemDocument } from './problem';
