// The upload-session stage of the request pipeline (decision 053): a multipart body of a route that signs in with a session cookie is
// read only when the request carries a live session of the route's audience.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { contractRegistry } from '../../../common/contract';
import { MULTIPART_ROUTES, isMultipartContentType } from '../../../common/multipart';
import { RequestPipeline } from '../../../common/pipeline';
import type { SubjectType } from '../db/schema';
import { SessionAuthenticator } from './session-authenticator';

/**
 * Finds whose session cookie a multipart request must carry, from its route and body type.
 *
 * Why: decision 053. A multipart body is parsed (up to 25 MiB, in memory) before the access guard reads the cookie, so the cookie of an
 * upload route is judged earlier, at the `upload-session` stage. Only the routes that sign in with a session cookie qualify: API keys
 * and ticket links are bounded by the `upload` limiter and the 5 MiB route bound instead.
 *
 * @param template the route template of the request (`/client/files`)
 * @param method the HTTP method (`HEAD` is read as `GET`, like the per-IP stage does)
 * @param contentType the `Content-Type` header
 * @returns the audience of the cookie, or `undefined` for a route or body type this stage does not judge
 */
export function uploadSessionSubject(
  template: string | undefined,
  method: string,
  contentType: string | undefined,
): SubjectType | undefined {
  if (template === undefined || !MULTIPART_ROUTES.has(template)) return undefined;
  if (!isMultipartContentType(contentType)) return undefined;
  const contract = contractRegistry.get(`${method === 'HEAD' ? 'GET' : method} ${template}`);
  const access = contract?.access;
  if (access === 'staff-session' || access === 'staff-permission') return 'staff';
  if (access === 'merchant-session') return 'client';
  if (access === 'customer-session') return 'customer';
  return undefined;
}

/**
 * Registers the `upload-session` stage with the request pipeline.
 *
 * Why: decision 053 and decision 018. The fourth stage, after the per-IP limit (so the upload point is counted first), runs in
 * `onRequest`, before the body is read: a multipart request on a session-cookie upload route without a live session of its audience is
 * answered `401` and its body is never buffered. The full checks (suspension, stage, approval, CSRF, permission) stay with the access guard.
 *
 * Failure policy: a request whose cookie cannot be judged because the session store fails is refused with that error (the body is
 * the expensive part).
 *
 * Side effects: the session lookup and the failed-lookup budget of {@link SessionAuthenticator.precheck}.
 *
 * @throws {AppError} `UNAUTHORIZED` (401) without a live session; `RATE_LIMITED` (429 with `Retry-After`) when the address used up its budget
 *   of unknown cookies
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
    const subject = uploadSessionSubject(request.routeOptions?.url, request.method, request.headers['content-type']);
    if (subject !== undefined) await this.authenticator.precheck(subject, request);
  }
}
