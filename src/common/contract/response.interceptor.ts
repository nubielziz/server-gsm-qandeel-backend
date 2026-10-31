// Response interceptor of a route contract (decision 008): the handler result is parsed with the success schema
// (unknown keys stripped) before it is sent; lists get x-total-count; a mismatch is a 500 RESPONSE_CONTRACT_VIOLATION.
import { type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type Observable, map } from 'rxjs';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import type { AnyRouteContract } from './define-route';

/**
 * The part of a reply the interceptor uses (a Fastify reply).
 *
 * Why: the interceptor only sets and reads headers, so tests can hand it a tiny fake instead of a Fastify reply.
 */
export interface HeaderSink {
  header(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}

function isListResult(value: unknown): value is { rows: unknown; total: unknown } {
  return typeof value === 'object' && value !== null && 'rows' in value && 'total' in value;
}

const violation = (cause: unknown) => new AppError('RESPONSE_CONTRACT_VIOLATION', { cause });

/**
 * Turns a handler result into the body the contract promises.
 *
 * Why: unknown fields must never leak (no `passwordHash` by accident) and a handler that drifts from its contract is a
 * server bug, not a client one (decision 008). The failure is logged by the exception filter with the cause.
 *
 * @param contract the route contract
 * @param result what the handler returned (`{ rows, total }` for a list route)
 * @param reply used to set `x-total-count` and the content type
 * @returns the body to send (`undefined` for 204)
 * @throws {AppError} `RESPONSE_CONTRACT_VIOLATION` (500) when the result does not satisfy the success schema
 */
export function shapeResponse(contract: AnyRouteContract, result: unknown, reply: HeaderSink): unknown {
  const { status, schema, contentType, list } = contract.success;
  if (status === 204) return undefined;
  if (!schema) {
    // A file or text answer: the handler produced the bytes; only the media type is the contract's job.
    if (contentType && reply.getHeader('content-type') === undefined) reply.header('content-type', contentType);
    return result;
  }
  if (list) {
    if (!isListResult(result) || !Number.isSafeInteger(result.total) || (result.total as number) < 0) {
      throw violation(new Error('A list handler must return { rows, total } with a non-negative integer total'));
    }
    const parsed = z.array(schema).safeParse(result.rows);
    if (!parsed.success) throw violation(parsed.error);
    reply.header('x-total-count', String(result.total));
    return parsed.data;
  }
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw violation(parsed.error);
  return parsed.data;
}

/**
 * Interceptor applied to every contract route by `@Route`.
 *
 * Why: see {@link shapeResponse}; keeping it an interceptor means every route is checked, whichever controller
 * wrote the handler.
 */
export class ContractResponseInterceptor implements NestInterceptor {
  constructor(private readonly contract: AnyRouteContract) {}

  /**
   * Runs the handler and shapes its result with {@link shapeResponse}.
   *
   * @param context the request being handled (gives the reply used for headers)
   * @param next the rest of the pipeline, ending in the handler
   * @returns the stream of the shaped body
   * @throws {AppError} `RESPONSE_CONTRACT_VIOLATION` (500) when the handler result breaks the contract
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    return next.handle().pipe(map((result: unknown) => shapeResponse(this.contract, result, reply)));
  }
}
