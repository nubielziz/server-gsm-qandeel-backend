// The guard dispatcher (decision 018): one global guard that reads the route's contract and runs, in the pipeline order of
// decision 018, authentication by access kind, then the CSRF guard, then the permission guard, then (storefront writes only) the
// anti-bot check of decision 034.
import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getContract } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { setRequestActor } from '../../../common/request-context';
import { TurnstileGuard } from '../../../infra/turnstile';
import { DOCUMENTATION_ROUTES } from '../../platform';
import { AccessHandlers } from './access-handlers';
import { actorOf, setAccessState } from './access-state';
import { CsrfGuard } from './csrf.guard';
import { PermissionGuard } from './permission.guard';

/**
 * Authenticates and authorises every request from the route's contract.
 *
 * Why: security must not depend on each controller remembering a decorator. The contract of a route says how it
 * authenticates (`access`), which sign-in stages it accepts (`sessionStages`), whether it needs a permission and what its
 * CSRF protection is; this guard enforces all of it for every route, in the order of decision 018: authentication (with the
 * account state), CSRF, permission, then the anti-bot check of a `turnstile` route (decision 034, last so that a refused
 * caller never costs an outbound call); validation, the handler and the audit follow in the route's own pipes and interceptors.
 *
 * A route without a contract is refused (fail closed); the documentation routes (`DOCUMENTATION_ROUTES`) are the exception and
 * keep their own guard, which applies `REFERENCE_DOCS`.
 *
 * Side effects: sets the actor and IP of the request context (the audit log reads them); see the guards it calls.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly handlers: AccessHandlers,
    private readonly csrf: CsrfGuard,
    private readonly permissions: PermissionGuard,
    private readonly turnstile: TurnstileGuard,
  ) {}

  /**
   * Runs the guards of the route's access kind.
   *
   * @param context the request being handled
   * @returns true when the request may proceed to validation and the handler
   * @throws {AppError} the refusal: `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403), `IP_NOT_ALLOWED` (403, an API key's own
   *   address list), `CSRF_FAILED` (403), `FORBIDDEN` (403); `RATE_LIMITED` (429, an API key's limit); `NOT_FOUND` (404) and
   *   `TOKEN_INVALID` (410) for a capability token that opens nothing; `WEBHOOK_SIGNATURE_INVALID` (400);
   *   `TURNSTILE_FAILED` (403) for a storefront write whose anti-bot token is missing or bad; `INTERNAL_ERROR` (500) for a
   *   route that has no contract
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const contract = getContract(context.getHandler());
    if (!contract) {
      if (isDocumentationRoute(request)) return true;
      const route = `${request.method} ${request.routeOptions?.url ?? request.url}`;
      this.logger.error(`${route} has no route contract, so it is refused. Define it with defineRoute and @Route.`);
      throw new AppError('INTERNAL_ERROR', {
        detail: `${route} has no route contract, so the access guard refuses it.`,
      });
    }

    const state = await this.handlers.handlerFor(contract.access).authenticate(request, contract, context);
    setAccessState(request, state);
    const actor = state.principal ? actorOf(state.principal) : undefined;
    if (actor) setRequestActor(actor, request.ip);

    this.csrf.canActivate(context);
    this.permissions.canActivate(context);
    await this.turnstile.canActivate(context);
    return true;
  }
}

/** True for the internal reference pages, which have no contract (a HEAD request is the GET route). */
function isDocumentationRoute(request: FastifyRequest): boolean {
  const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
  const url = request.routeOptions?.url;
  return url !== undefined && (DOCUMENTATION_ROUTES as readonly string[]).includes(`${method} ${url}`);
}
