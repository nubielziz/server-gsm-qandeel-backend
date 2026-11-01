// The two access handlers that authenticate with a merchant API key: REST v1 (`Authorization: Bearer <key>`, scope = the
// contract's permission) and the Dhru surface (`username` + `apiaccesskey` in the body, scope `dhru`).
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../../common/contract';
import type { AccessHandler } from '../../access-handlers';
import type { AccessState } from '../../access-state';
import type { ApiKeyAuthenticator } from './api-key.authenticator';
import { DHRU_SCOPE } from './api-key.rules';

/**
 * Reads the key of an `Authorization: Bearer <key>` header.
 *
 * Why: REST v1 sends the merchant API key this way (ALIGNMENT § 7). The scheme is case-insensitive (RFC 9110); anything else
 * (Basic, a missing key, extra words) carries no key.
 *
 * @param header the value of the `Authorization` header
 * @returns the key, or `undefined` when the header is not `Bearer <key>`
 */
export function bearerKeyOf(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^bearer +(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** The credentials of a Dhru request. */
export interface DhruCredentials {
  readonly username: string;
  readonly apiAccessKey: string;
}

/**
 * Reads `username` and `apiaccesskey` from a Dhru request body.
 *
 * Why: decision 026: the standard form fields of `POST /api/index.php`, sent form-encoded or as JSON. The guard runs before the
 * validation pipe, so it reads the parsed body as it is; a repeated field (an array) or a non-text value is not a credential.
 *
 * @param body the parsed request body
 * @returns both credentials, or `undefined` when either is missing or empty
 */
export function dhruCredentialsOf(body: unknown): DhruCredentials | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { username, apiaccesskey } = body as Record<string, unknown>;
  if (typeof username !== 'string' || typeof apiaccesskey !== 'string') return undefined;
  const credentials = { username: username.trim(), apiAccessKey: apiaccesskey.trim() };
  return credentials.username === '' || credentials.apiAccessKey === '' ? undefined : credentials;
}

/**
 * Authenticates REST v1 routes with a Bearer API key.
 *
 * Why: decision 018; the scope the key must list is the contract's `permission` (`orders:write`), checked with the key's other
 * rules by {@link ApiKeyAuthenticator}.
 */
export class ApiKeyAccessHandler implements AccessHandler {
  constructor(private readonly authenticator: ApiKeyAuthenticator) {}

  /**
   * Authenticates a request with the Bearer key.
   *
   * @param request the Fastify request
   * @param contract the route contract (its `permission` is the scope)
   * @returns the API-key principal
   * @throws {AppError} see {@link ApiKeyAuthenticator.authenticate}
   */
  async authenticate(request: FastifyRequest, contract: AnyRouteContract): Promise<AccessState> {
    const principal = await this.authenticator.authenticate(request, {
      key: bearerKeyOf(request.headers.authorization),
      // A v1 route without a scope cannot exist (defineRoute refuses it); the empty scope is refused for every key, `*` included.
      scope: contract.permission ?? '',
      surface: contract.surface,
    });
    return { principal };
  }
}

/**
 * Authenticates the Dhru endpoint with `username` + `apiaccesskey`.
 *
 * Why: decision 026: the `apiaccesskey` is a merchant API key that carries the `dhru` scope and belongs to the merchant with that
 * username. Every refusal is answered in the Dhru envelope with HTTP 200 (the surface's error formatter), and a credential
 * that is not accepted says `Authentication Failed`.
 */
export class DhruCredentialsAccessHandler implements AccessHandler {
  constructor(private readonly authenticator: ApiKeyAuthenticator) {}

  /**
   * Authenticates a request with the Dhru credentials of its body.
   *
   * @param request the Fastify request
   * @param contract the route contract
   * @returns the API-key principal
   * @throws {AppError} see {@link ApiKeyAuthenticator.authenticate}; `UNAUTHORIZED` when a credential is missing
   */
  async authenticate(request: FastifyRequest, contract: AnyRouteContract): Promise<AccessState> {
    const credentials = dhruCredentialsOf(request.body);
    const principal = await this.authenticator.authenticate(request, {
      key: credentials?.apiAccessKey,
      username: credentials?.username,
      scope: DHRU_SCOPE,
      surface: contract.surface,
    });
    return { principal };
  }
}
