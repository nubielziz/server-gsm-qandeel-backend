// The staff gate of the internal API reference (decision 017): a staff session with `system:read`. It is provided under
// REFERENCE_DOCS_GUARD, so `REFERENCE_DOCS=staff` (the production default) works.
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors';
import { setRequestActor } from '../../../common/request-context';
import { DEFAULT_SESSION_STAGES } from '../../../common/contract';
import { actorOf, setAccessState } from './access-state';
import { grants } from './permission-grammar';
import { SessionAuthenticator } from './session-authenticator';

/**
 * The permission the internal reference needs.
 *
 * Why: decision 017: in production the internal reference is for staff with `system:read`.
 */
export const REFERENCE_DOCS_PERMISSION = 'system:read';

/**
 * Lets a staff member with `system:read` read `GET /reference` and `GET /reference/openapi.json`.
 *
 * Why: these routes have no route contract (they are not map routes), so the dispatcher lets them through to their own guard
 * and this guard checks the session and the permission itself. A caller without a session gets `401`, one without the
 * permission `403 FORBIDDEN` (the pages are GETs, so there is no CSRF check).
 */
@Injectable()
export class StaffSystemReadGuard implements CanActivate {
  constructor(private readonly authenticator: SessionAuthenticator) {}

  /**
   * Checks the staff session and its permission.
   *
   * @param context the request being handled
   * @returns true when the caller is a signed-in staff member with `system:read`
   * @throws {AppError} `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403) or `FORBIDDEN` (403)
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const { view, principal } = await this.authenticator.authenticate('staff', request, {
      stages: DEFAULT_SESSION_STAGES,
    });
    if (principal.kind !== 'staff' || !grants(principal.permissions, REFERENCE_DOCS_PERMISSION)) {
      throw new AppError('FORBIDDEN', { detail: `You need the ${REFERENCE_DOCS_PERMISSION} permission to do this.` });
    }
    setAccessState(request, { principal, session: view });
    setRequestActor(actorOf(principal), request.ip);
    return true;
  }
}
