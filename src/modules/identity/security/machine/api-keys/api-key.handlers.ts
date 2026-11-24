// The access handler that authenticates with a merchant API key: the Dhru surface (`username` + `apiaccesskey` in the body).
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../../common/contract';
import type { AccessHandler } from '../../access-handlers';
import type { AccessState } from '../../access-state';
import type { ApiKeyAuthenticator } from './api-key.authenticator';
import { requestPoints } from './request-points';

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
 * Authenticates the Dhru endpoint with `username` + `apiaccesskey`.
 *
 * Why: decision 026: the `apiaccesskey` is a merchant API key that belongs to the merchant with that username. Every refusal is
 * answered in the Dhru envelope with HTTP 200 (the surface's error formatter), and a credential that is not accepted says
 * `Authentication Failed`.
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
      points: requestPoints(contract.key, request.body),
    });
    return { principal };
  }
}
