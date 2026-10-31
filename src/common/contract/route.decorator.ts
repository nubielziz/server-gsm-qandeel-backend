// @Route(contract): the one decorator that turns a contract into a Nest route (decision 008).
// It sets the method, path and status, the validation pipe, the response interceptor and the OpenAPI metadata.
import {
  type ExecutionContext,
  HttpCode,
  RequestMapping,
  RequestMethod,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  UsePipes,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from './define-route';
import { openApiDecorators } from './openapi';
import { ContractResponseInterceptor } from './response.interceptor';
import { CONTRACT_HEADERS_MARKER, ContractInputGuard, ContractValidationPipe } from './validation.pipe';

/**
 * Reflect metadata key under which a handler stores its contract (read by guards and docs).
 *
 * Why: guards (permission, CSRF, API scopes) read `access` and `permission` from the route without a second registry.
 */
export const CONTRACT_METADATA = Symbol.for('gsm.contract');

/**
 * Binds a controller method to a route contract.
 *
 * Why: one decorator per endpoint keeps the path, status, validation, response check and documentation in sync with
 * the contract (decision 008). Controllers use a bare `@Controller()`; the path comes from the manifest key.
 * Every input the contract declares is validated before the handler runs, whether or not the handler reads it. Read
 * inputs with `@Param()`, `@Query()`, `@Body()` and `@ContractHeaders()` (no key) to get the parsed value.
 *
 * @param contract the contract from `defineRoute`
 * @returns a method decorator
 * @route the contract's own `METHOD /path`
 *
 * @example
 * ```ts
 * @Controller()
 * class StaffController {
 *   @Route(showStaff)
 *   show(@Param() params: ParamsOf<typeof showStaff>): Promise<ResultOf<typeof showStaff>> {
 *     return this.staff.show(params.id);
 *   }
 * }
 * ```
 */
export function Route(contract: AnyRouteContract): MethodDecorator {
  return applyDecorators(
    RequestMapping({ method: RequestMethod[contract.method], path: contract.path }),
    HttpCode(contract.success.status),
    SetMetadata(CONTRACT_METADATA, contract),
    UseGuards(new ContractInputGuard(contract)),
    UsePipes(new ContractValidationPipe(contract)),
    UseInterceptors(new ContractResponseInterceptor(contract)),
    ...openApiDecorators(contract),
  );
}

/**
 * Reads the contract a handler was bound to with {@link Route}.
 *
 * Why: guards (permission, CSRF, API scopes) and the docs read `access`, `permission` and `surface` from the route.
 *
 * @param handler the controller method (`context.getHandler()`)
 * @returns the contract, or `undefined` for a handler without `@Route`
 */
export function getContract(handler: object): AnyRouteContract | undefined {
  return Reflect.getMetadata(CONTRACT_METADATA, handler) as AnyRouteContract | undefined;
}

const RawHeaders = createParamDecorator(
  (_marker: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<FastifyRequest>().headers,
);

/**
 * Parameter decorator for the request headers a contract declares (`headers: z.object({ 'idempotency-key': ... })`).
 *
 * Why: `@Headers()` is not recognised by the validation pipe; this one is, so the handler gets parsed headers.
 *
 * @returns a parameter decorator; the value is the parsed `headers` schema output
 */
export const ContractHeaders = (): ParameterDecorator => RawHeaders(CONTRACT_HEADERS_MARKER);
