// Gate of the internal reference routes (GET /reference, GET /reference/openapi.json), decision 017:
// REFERENCE_DOCS = open (everyone), off (404) or staff (a staff session with system:read, provided by the identity module).
import { type CanActivate, type ExecutionContext, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';

/**
 * Injection token of the staff guard behind `REFERENCE_DOCS=staff`.
 *
 * Why: the staff session and the permission check belong to the identity module, which provides `StaffSystemReadGuard`
 * (a staff session with `system:read`) under this token from its global `SecurityModule`. If no provider exists, `staff`
 * behaves like `off`, so a deployment never serves the internal reference to everyone by accident. The reference routes
 * have no route contract (`getContract` finds nothing on their handlers; the guard dispatcher lets them through because
 * they are in `DOCUMENTATION_ROUTES`), so the provided guard checks the session and the permission itself.
 */
export const REFERENCE_DOCS_GUARD = Symbol.for('gsm.REFERENCE_DOCS_GUARD');

/**
 * Applies `REFERENCE_DOCS` to the internal reference routes.
 *
 * Why: the internal document lists every route, permission and error of the API (decision 017): fine in development,
 * staff only in production, and switchable off. A refusal answers `404`, like a route that does not exist, so a closed
 * reference does not even confirm its own path.
 */
@Injectable()
export class ReferenceAccessGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(REFERENCE_DOCS_GUARD) private readonly staffGuard?: CanActivate,
  ) {}

  /**
   * Decides whether the caller may read the internal reference.
   *
   * @param context the request being handled
   * @returns true when the mode lets the request through
   * @throws {NotFoundException} (`404 NOT_FOUND`) in `off` mode, and in `staff` mode while no staff guard is provided
   */
  canActivate(context: ExecutionContext): ReturnType<CanActivate['canActivate']> {
    switch (this.config.http.referenceDocs) {
      case 'open':
        return true;
      case 'staff':
        // The staff guard throws its own 401/403 problem for a caller without the permission.
        if (this.staffGuard) return this.staffGuard.canActivate(context);
        throw new NotFoundException();
      case 'off':
        throw new NotFoundException();
    }
  }
}
