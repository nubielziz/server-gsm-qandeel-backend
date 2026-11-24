// The upload-session stage of the request pipeline (decision 053): a multipart body of a route that signs in with a session cookie is
// read only when the request carries a live session of the route's audience.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type RouteRank, contractRegistry, defaultRankOf } from '../../../common/contract';
import { MULTIPART_ROUTES, isMultipartContentType } from '../../../common/multipart';
import { RequestPipeline } from '../../../common/pipeline';
import type { SubjectType } from '../db/schema';
import { SessionAuthenticator } from './session-authenticator';

/** Whose session cookie a multipart request must carry, and the rank its route serves. */
export interface UploadSessionTarget {
  readonly subject: SubjectType;
  /** `contract.rank` of the route: `merchant`, `retail` or `any` for an account route, `null` for staff. */
  readonly rank: RouteRank | null;
}

/**
 * Finds whose session cookie a multipart request must carry and which rank its route serves, from its route and body type.
 *
 * Why: decision 053. A multipart body is parsed (up to 25 MiB, in memory) before the access guard reads the cookie, so the cookie of an
 * upload route is judged earlier, at the `upload-session` stage. Only the routes that sign in with a session cookie qualify: API keys
 * and ticket links are bounded by the `upload` limiter and the 5 MiB route bound instead. Both account access kinds map to the one
 * subject `account`, and the route's rank goes with it, so a session of the wrong rank is refused before the body is read (decision
 * 064).
 *
 * @param template the route template of the request (`/client/files`)
 * @param method the HTTP method (`HEAD` is read as `GET`, like the per-IP stage does)
 * @param contentType the `Content-Type` header
 * @returns the audience of the cookie and the rank of the route, or `undefined` for a route or body type this stage does not judge
 */
export function uploadSessionTarget(
  template: string | undefined,
  method: string,
  contentType: string | undefined,
): UploadSessionTarget | undefined {
  if (template === undefined || !MULTIPART_ROUTES.has(template)) return undefined;
  if (!isMultipartContentType(contentType)) return undefined;
  const contract = contractRegistry.get(`${method === 'HEAD' ? 'GET' : method} ${template}`);
  const access = contract?.access;
  if (access === 'staff-session' || access === 'staff-permission') return { subject: 'staff', rank: null };
  if (access === 'merchant-session' || access === 'customer-session') {
    return { subject: 'account', rank: contract?.rank ?? defaultRankOf(access) };
  }
  return undefined;
}

/**
 * Finds whose session cookie a multipart request must carry, from its route and body type.
 *
 * Why: the audience half of {@link uploadSessionTarget}, for callers that do not judge the rank.
 *
 * @param template the route template of the request (`/client/files`)
 * @param method the HTTP method (`HEAD` is read as `GET`, like the per-IP stage does)
 * @param contentType the `Content-Type` header
 * @returns `staff` or `account`, or `undefined` for a route or body type this stage does not judge
 */
export function uploadSessionSubject(
  template: string | undefined,
  method: string,
  contentType: string | undefined,
): SubjectType | undefined {
  return uploadSessionTarget(template, method, contentType)?.subject;
}

/**
 * Registers the `upload-session` stage with the request pipeline.
 *
 * Why: decision 053 and decision 018. The fourth stage, after the per-IP limit (so the upload point is counted first), runs in
 * `onRequest`, before the body is read: a multipart request on a session-cookie upload route without a live session of its audience is
 * answered `401`, and one from an account of another rank than the route serves `403 RANK_NOT_ALLOWED` (decision 064); its body is
 * never buffered. The full checks (suspension, stage, CSRF, permission) stay with the access guard.
 *
 * Failure policy: a request whose cookie cannot be judged because the session store fails is refused with that error (the body is
 * the expensive part).
 *
 * Side effects: the session lookup and the failed-lookup budget of {@link SessionAuthenticator.precheck}.
 *
 * @throws {AppError} `UNAUTHORIZED` (401) without a live session; `RANK_NOT_ALLOWED` (403) for an account of another rank;
 *   `RATE_LIMITED` (429 with `Retry-After`) when the address used up its budget of unknown cookies
 */
@Injectable()
export class UploadSessionHook implements OnModuleInit {
  constructor(
    private readonly pipeline: RequestPipeline,
    private readonly authenticator: SessionAuthenticator,
  ) {}

  /** Registers the stage. */
  onModuleInit(): void {
    this.pipeline.register('upload-session', (request) => this.handle(request));
  }

  /**
   * Judges one request.
   *
   * @param request the request
   * @throws {AppError} see the class
   */
  async handle(request: FastifyRequest): Promise<void> {
    const target = uploadSessionTarget(request.routeOptions?.url, request.method, request.headers['content-type']);
    if (target !== undefined) await this.authenticator.precheck(target.subject, request, target.rank);
  }
}
