// The `@CurrentStoreCustomer()` parameter decorator for the risk module's storefront routes: the signed-in customer of a
// `customer-session` route (the customers module has its own for its controllers).
import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors';
import { type CustomerPrincipal, principalOf } from '../../identity';

/** The signed-in customer of a storefront route. */
export type StoreCustomer = CustomerPrincipal;

/**
 * Parameter decorator: the signed-in customer of a `customer-session` route.
 *
 * Why: the privacy routes act on the customer's own requests only, by this id; this fails loudly if the route is not a customer route.
 *
 * @throws {AppError} `UNAUTHORIZED` (401) when the request was not authenticated as a customer
 */
export const CurrentStoreCustomer = createParamDecorator((_data: unknown, context: ExecutionContext): StoreCustomer => {
  const principal = principalOf(context.switchToHttp().getRequest<FastifyRequest>());
  if (principal?.kind !== 'customer') throw new AppError('UNAUTHORIZED');
  return principal;
});
