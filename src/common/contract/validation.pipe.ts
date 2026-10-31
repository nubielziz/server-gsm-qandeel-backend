// Validation pipe of a route contract (decision 008): parses params, query, body and headers with the contract's
// zod schemas and answers 422 VALIDATION_FAILED with one errors[] item per issue.
import { type ArgumentMetadata, type CanActivate, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError, type FieldError } from '../errors/app-error';
import type { AnyRouteContract } from './define-route';

/**
 * Marker the headers parameter decorator passes, so the pipe can tell `@ContractHeaders()` from other custom ones.
 *
 * Why: `@Headers()` and other custom decorators must not be mistaken for the contract's headers.
 */
export const CONTRACT_HEADERS_MARKER = '__gsm_contract_headers__';

/** The four request inputs a contract can validate. */
export type InputLocation = 'params' | 'query' | 'body' | 'headers';

/**
 * Finds which contract input a handler parameter reads.
 *
 * Why: the pipe validates only the four inputs a contract can declare.
 *
 * @param metadata Nest's description of the parameter (`@Param()`, `@Query()`, `@Body()`, `@ContractHeaders()`)
 * @returns the input, or `undefined` for parameters the contract does not validate (`@Req()`, other custom ones)
 */
export function locationOf(metadata: ArgumentMetadata): InputLocation | undefined {
  switch (metadata.type) {
    case 'param':
      return 'params';
    case 'query':
      return 'query';
    case 'body':
      return 'body';
    case 'custom':
      return metadata.data === CONTRACT_HEADERS_MARKER ? 'headers' : undefined;
    default:
      return undefined;
  }
}

function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/**
 * Converts zod issues to problem+json `errors[]` items.
 *
 * Why: the console maps `errors[].field` (a dotted path equal to the request key, e.g. `items.0.imei`) onto form
 * fields (ALIGNMENT § 5). An issue about the whole input names the input (`body`, `query`, `params`, `headers`);
 * an unknown-keys issue becomes one item per key.
 *
 * @param location which input was validated
 * @param issues the zod issues
 * @returns one item per issue (per key for unknown keys)
 */
export function toFieldErrors(location: InputLocation, issues: readonly z.core.$ZodIssue[]): FieldError[] {
  const errors: FieldError[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors.push({ field: joinPath([...issue.path, key]), code: issue.code, message: issue.message });
      }
      continue;
    }
    errors.push({ field: joinPath(issue.path) || location, code: issue.code, message: issue.message });
  }
  return errors;
}

/**
 * Builds the 422 error of a failed validation.
 *
 * Why: decision 028 gives every route one 422 shape.
 *
 * @param location which input failed
 * @param error the zod error
 * @returns `AppError('VALIDATION_FAILED')` with the field errors
 */
export function validationFailed(location: InputLocation, error: z.ZodError): AppError {
  return failure(toFieldErrors(location, error.issues));
}

/** Parsed inputs by the raw object they came from, so the guard parses once and the pipe reuses the result. */
const parsedByRaw = new WeakMap<object, unknown>();

/** The request parts a contract validates. */
export interface RawInputs {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly headers?: unknown;
}

/**
 * Validates every input the contract declares and remembers the parsed values.
 *
 * Why: a route must answer 422 for a bad declared input even when its handler never reads it (a header used only by an
 * interceptor, a body the handler ignores); all problems are reported together, one `errors[]` item per issue.
 *
 * @param contract the route contract
 * @param request the raw Fastify request parts
 * @throws {AppError} `VALIDATION_FAILED` (422) listing the issues of every declared input
 */
export function validateInputs(contract: AnyRouteContract, request: RawInputs): void {
  const errors: FieldError[] = [];
  for (const location of ['params', 'query', 'headers', 'body'] as const) {
    const schema = contract[location];
    if (!schema) continue;
    const raw = request[location];
    const result = schema.safeParse(raw);
    if (result.success) {
      if (typeof raw === 'object' && raw !== null) parsedByRaw.set(raw, result.data);
    } else {
      errors.push(...toFieldErrors(location, result.error.issues));
    }
  }
  if (errors.length > 0) throw failure(errors);
}

function failure(errors: readonly FieldError[]): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: errors.length === 1 ? 'One field is not valid.' : `${errors.length} fields are not valid.`,
    errors,
  });
}

/**
 * Guard that runs {@link validateInputs} for a route.
 *
 * Why: Nest runs guards after the global authentication, CSRF and permission guards and before pipes and the handler,
 * which is the validation slot of the request pipeline (decision 018).
 */
export class ContractInputGuard implements CanActivate {
  constructor(private readonly contract: AnyRouteContract) {}

  canActivate(context: ExecutionContext): boolean {
    validateInputs(this.contract, context.switchToHttp().getRequest<RawInputs>());
    return true;
  }
}

/**
 * Pipe applied to every handler parameter of a route: validates the input with the contract's schema and returns the
 * parsed value (ids as numbers, list queries as parsed objects).
 *
 * Why: validation must be the one pipe every route shares, so the 422 shape is identical everywhere (decision 028).
 * Reading an input the contract does not declare is a programming error, not a client error, and fails loudly
 * instead of passing raw input to the handler.
 *
 * @throws {AppError} `VALIDATION_FAILED` (422) when the input does not satisfy its schema
 */
export class ContractValidationPipe implements PipeTransform {
  constructor(private readonly contract: AnyRouteContract) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const location = locationOf(metadata);
    if (!location) return value;
    const schema = this.contract[location];
    if (!schema) {
      throw new Error(`${this.contract.key}: the handler reads the ${location} but the contract declares none`);
    }
    if (typeof metadata.data === 'string' && metadata.data !== CONTRACT_HEADERS_MARKER) {
      throw new Error(
        `${this.contract.key}: use @Param()/@Query()/@Body() without a key; the contract validates the whole input`,
      );
    }
    // The guard already parsed this exact object: reuse the result instead of parsing twice.
    if (typeof value === 'object' && value !== null && parsedByRaw.has(value)) return parsedByRaw.get(value);
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw validationFailed(location, result.error);
  }
}
