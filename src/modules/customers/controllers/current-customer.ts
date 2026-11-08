// The `@CurrentCustomer()` parameter decorator: the signed-in customer of a storefront account route.
import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors';
import { type CustomerPrincipal, principalOf } from '../../identity';

/**
 * Parameter decorator: the signed-in customer of a `customer-session` route.
 *
 * Why: account handlers act on the customer's own records only, by this id; this fails loudly if the route is not a customer
 * route.
 *
 * @throws {AppError} `UNAUTHORIZED` (401) when the request was not authenticated as a customer
 */
export const CurrentCustomer = createParamDecorator((_data: unknown, context: ExecutionContext): CustomerPrincipal => {
  const principal = principalOf(context.switchToHttp().getRequest<FastifyRequest>());
  if (principal?.kind !== 'customer') throw new AppError('UNAUTHORIZED');
  return principal;
});

/**
 * Parameter decorator: the one-time link a `link-token` route was opened with.
 *
 * Why: the guard resolved the token in the body to the `auth_tokens` row; the use case reads that row by its id.
 *
 * @throws {AppError} `TOKEN_INVALID` (410) when the request was not authenticated by a link token
 */
export const CurrentLink = createParamDecorator((_data: unknown, context: ExecutionContext): number => {
  const principal = principalOf(context.switchToHttp().getRequest<FastifyRequest>());
  if (principal?.kind !== 'capability' || principal.access !== 'link-token') throw new AppError('TOKEN_INVALID');
  return principal.resourceId;
});
