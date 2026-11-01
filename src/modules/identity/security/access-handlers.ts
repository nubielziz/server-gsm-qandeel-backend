// The access kinds and who authenticates each (decision 018): a table from a contract's `access` to a handler. The session
// kinds and `public` are built here; the machine kinds (API keys, Dhru credentials, gateway signatures, URL secrets and
// capability tokens) start as fail-closed placeholders and `MachineAccessInstaller` (security/machine) replaces them with
// their guards when the security module is built. The guard dispatcher reads this table.
import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ACCESS_KINDS, type AccessKind, type AnyRouteContract } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { MetricsAccessGuard } from '../../../infra/metrics';
import type { SubjectType } from '../db/schema';
import type { AccessState } from './access-state';
import { SessionAuthenticator } from './session-authenticator';

/**
 * Authenticates the requests of one access kind.
 *
 * Why: the dispatcher knows nothing about cookies, keys or signatures; it asks the handler of the route's access kind and gets
 * back who the caller is. P2.5c implements the machine kinds against this interface.
 */
export interface AccessHandler {
  /**
   * Authenticates a request or refuses it.
   *
   * @param request the Fastify request
   * @param contract the contract of the route being called
   * @param context the Nest execution context (for guards that already exist, such as the metrics guard)
   * @returns the principal and the session, when the kind has them; an empty object lets the request through unauthenticated
   * @throws {AppError} the refusal: `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` or `IP_NOT_ALLOWED` (403), `RATE_LIMITED` (429)
   */
  authenticate(
    request: FastifyRequest,
    contract: AnyRouteContract,
    context: ExecutionContext,
  ): Promise<AccessState> | AccessState;
}

/**
 * The machine access kinds: capability tokens (checkout, tracking, ticket, link), API keys, Dhru credentials, gateway
 * signatures and URL secrets.
 *
 * Why: the table starts with a fail-closed placeholder for each (every request refused), so a kind that has no guard
 * can never be open; `MachineAccessInstaller` replaces them at boot (P2.5c), and {@link AccessHandlers.isPlaceholder} tells
 * which are still unreplaced (an app built without the security module's machine part).
 */
export const PLACEHOLDER_ACCESS_KINDS = [
  'api-key',
  'dhru-credentials',
  'gateway-signature',
  'url-secret',
  'checkout-token',
  'tracking-token',
  'link-token',
  'ticket-token',
] as const satisfies readonly AccessKind[];

/** Lets every request through: the route is public (it may still get the Origin check of the CSRF guard). */
const PUBLIC_HANDLER: AccessHandler = { authenticate: () => ({}) };

/** Refuses every request: the guard of this kind is not built yet. */
const FAIL_CLOSED_HANDLER: AccessHandler = {
  authenticate(_request, contract) {
    // The Dhru surface answers in its own envelope, which says exactly this (decision 026).
    throw new AppError('UNAUTHORIZED', contract.surface === 'dhru' ? { detail: 'Authentication Failed' } : {});
  },
};

/** Authenticates with the session cookie of one subject type, accepting the stages of the contract. */
class SessionAccessHandler implements AccessHandler {
  constructor(
    private readonly authenticator: SessionAuthenticator,
    private readonly subjectType: SubjectType,
  ) {}

  async authenticate(request: FastifyRequest, contract: AnyRouteContract): Promise<AccessState> {
    const { view, principal } = await this.authenticator.authenticate(this.subjectType, request, {
      stages: contract.sessionStages,
    });
    return { principal, session: view };
  }
}

/**
 * The table of access handlers.
 *
 * Why: "every AccessKind has an entry" (a test checks it), so a new kind cannot be added to the contract layer without
 * deciding how it authenticates. The machine kinds start as placeholders and are replaced with {@link AccessHandlers.replace}.
 */
@Injectable()
export class AccessHandlers {
  private readonly handlers = new Map<AccessKind, AccessHandler>();
  private readonly placeholders = new Set<AccessKind>(PLACEHOLDER_ACCESS_KINDS);

  constructor(authenticator: SessionAuthenticator, metricsAccess: MetricsAccessGuard) {
    const sessionStaff = new SessionAccessHandler(authenticator, 'staff');
    for (const kind of ACCESS_KINDS) {
      switch (kind) {
        case 'public':
          this.handlers.set(kind, PUBLIC_HANDLER);
          break;
        case 'staff-session':
        case 'staff-permission':
          this.handlers.set(kind, sessionStaff);
          break;
        case 'merchant-session':
          this.handlers.set(kind, new SessionAccessHandler(authenticator, 'client'));
          break;
        case 'customer-session':
          this.handlers.set(kind, new SessionAccessHandler(authenticator, 'customer'));
          break;
        case 'internal-or-token':
          // /metrics: the network-or-token rule of the existing guard (decision 015).
          this.handlers.set(kind, {
            authenticate: (_request, _contract, context) => {
              metricsAccess.canActivate(context);
              return {};
            },
          });
          break;
        case 'api-key':
        case 'dhru-credentials':
        case 'gateway-signature':
        case 'url-secret':
        case 'checkout-token':
        case 'tracking-token':
        case 'link-token':
        case 'ticket-token':
          this.handlers.set(kind, FAIL_CLOSED_HANDLER);
          break;
      }
    }
  }

  /**
   * Returns the handler of an access kind.
   *
   * @param kind a contract's `access`
   * @returns its handler (never undefined: every kind has an entry)
   */
  handlerFor(kind: AccessKind): AccessHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`No access handler for "${kind}"`);
    return handler;
  }

  /**
   * Tells whether a kind still has its fail-closed placeholder.
   *
   * @param kind an access kind
   * @returns true until {@link AccessHandlers.replace} gave it a real handler
   */
  isPlaceholder(kind: AccessKind): boolean {
    return this.placeholders.has(kind);
  }

  /**
   * Gives an access kind its real handler (`MachineAccessInstaller` does it for the machine kinds; tests use it for stand-ins).
   *
   * @param kind the access kind
   * @param handler the handler that authenticates it
   */
  replace(kind: AccessKind, handler: AccessHandler): void {
    this.handlers.set(kind, handler);
    this.placeholders.delete(kind);
  }
}
