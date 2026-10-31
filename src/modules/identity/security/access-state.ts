// What the access guards learned about a request, kept for the guards that run after them (CSRF, permission) and for the
// handler. A WeakMap on the Fastify request: nothing is added to the request object itself.
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors';
import type { RequestActor } from '../../../common/request-context';
import type { Principal, StaffPrincipal } from './principal';
import type { SessionView } from './session.types';

/**
 * The result of authenticating a request.
 *
 * Why: the CSRF guard needs to know whether a cookie session authenticated the request (and which one), and the permission
 * guard needs the principal.
 */
export interface AccessState {
  /** The authenticated caller; absent on public routes. */
  readonly principal?: Principal;
  /** The session that authenticated the request; absent unless the route authenticates with a cookie. */
  readonly session?: SessionView;
}

const states = new WeakMap<object, AccessState>();

/**
 * Remembers the result of authenticating a request.
 *
 * @param request the Fastify request
 * @param state the principal and session the guards found
 */
export function setAccessState(request: FastifyRequest, state: AccessState): void {
  states.set(request, state);
}

/**
 * Returns what the guards learned about a request.
 *
 * @param request the Fastify request
 * @returns the state; empty when no guard authenticated the request (a public route)
 */
export function accessStateOf(request: FastifyRequest): AccessState {
  return states.get(request) ?? {};
}

/**
 * Returns the authenticated caller of a request.
 *
 * @param request the Fastify request
 * @returns the principal, or `undefined` on a public route
 */
export function principalOf(request: FastifyRequest): Principal | undefined {
  return accessStateOf(request).principal;
}

/**
 * Describes a principal for the request context (the audit log reads it).
 *
 * @param principal the authenticated caller
 * @returns the actor type (`staff`, `client` for a merchant, `customer`) and id
 */
export function actorOf(principal: Principal): RequestActor {
  switch (principal.kind) {
    case 'staff':
      return { type: 'staff', id: principal.staffId };
    case 'merchant':
      return { type: 'client', id: principal.clientId };
    case 'customer':
      return { type: 'customer', id: principal.customerId };
  }
}

/**
 * Parameter decorator: the authenticated caller of the route.
 *
 * Why: handlers of session routes need the id of the caller (ownership checks, audit); the guard has already refused
 * anyone else. On a public route the value is `undefined`.
 *
 * @example
 * `me(@CurrentPrincipal() principal: Principal)`
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined =>
    principalOf(context.switchToHttp().getRequest<FastifyRequest>()),
);

/**
 * Parameter decorator: the signed-in staff member of an admin route.
 *
 * Why: admin handlers always act for a staff member; this fails loudly if the route is not a staff route.
 *
 * @throws {AppError} `UNAUTHORIZED` (401) when the request was not authenticated as staff
 */
export const CurrentStaff = createParamDecorator((_data: unknown, context: ExecutionContext): StaffPrincipal => {
  const principal = principalOf(context.switchToHttp().getRequest<FastifyRequest>());
  if (principal?.kind !== 'staff') throw new AppError('UNAUTHORIZED');
  return principal;
});
