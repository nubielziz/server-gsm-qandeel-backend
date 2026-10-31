// The permission guard (decision 018): the contract's `permission` against the permissions of the caller's role.
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getContract } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { accessStateOf } from './access-state';
import { grants } from './permission-grammar';

/**
 * Refuses a staff member whose role lacks the permission a route needs.
 *
 * Why: decision 018 checks the role's current permissions on every request (no snapshot per session), with the grammar of
 * `permission-grammar.ts`. The refusal is `403 FORBIDDEN` and its detail names the missing permission, which the console
 * shows; it never signs the caller out (ALIGNMENT § 3). Runs after authentication and CSRF.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  /**
   * Checks the permission of a request.
   *
   * @param context the request being handled
   * @returns true when the route needs no permission or the caller has it
   * @throws {AppError} `FORBIDDEN` (403) naming the missing permission; `UNAUTHORIZED` (401) when a permission route was not
   *   authenticated as staff (a programming error that fails closed)
   */
  canActivate(context: ExecutionContext): boolean {
    const contract = getContract(context.getHandler());
    if (!contract || contract.permission === null) return true;
    const { principal } = accessStateOf(context.switchToHttp().getRequest<FastifyRequest>());
    if (principal?.kind !== 'staff') throw new AppError('UNAUTHORIZED');
    if (!grants(principal.permissions, contract.permission)) {
      throw new AppError('FORBIDDEN', { detail: `You need the ${contract.permission} permission to do this.` });
    }
    return true;
  }
}
