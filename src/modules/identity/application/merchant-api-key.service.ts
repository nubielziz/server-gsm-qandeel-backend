// MerchantApiKeyService: the use cases of the merchant's own API keys (routes /client/api-keys, MISMATCHES B155): list, create
// (shown once), rename or change the allowed addresses, and revoke.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import {
  type ApiKeyWire,
  DEFAULT_RATE_LIMIT_PER_MIN,
  MAX_LIVE_KEYS,
  apiKeyToWire,
  checkAllowedIps,
  checkScopes,
  composeApiKey,
} from '../domain/api-key-input';
import {
  type ApiKeySortField,
  countLiveKeys,
  insertKey,
  listKeysOfClient,
  lockKey,
  lockKeysOfClient,
  revokeKeyRow,
  updateKey,
} from '../infra/api-key-manage.repository';
import type { MerchantPrincipal } from '../security/principal';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';

/** The range and sort of a list request, already parsed and checked by the contract. */
export interface ApiKeyListRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sort: readonly { readonly field: ApiKeySortField; readonly order: 'asc' | 'desc' }[];
}

/** What a merchant sends to create a key. */
export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly allowedIps?: readonly string[] | undefined;
  readonly expiresAt?: string | undefined;
}

/** The answer of a creation: the key as the lists show it, and the full key, shown this once. */
export interface CreatedApiKey {
  readonly key: ApiKeyWire;
  readonly secret: string;
}

/** A field error of the portal's forms: `422 VALIDATION_FAILED` on one request key. */
function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

/**
 * Manages the API keys of the signed-in merchant.
 *
 * Why: B155 and decision 019. A key authenticates REST v1 and Dhru calls (P2.5c); the merchant creates, limits and revokes its
 * own. Only the keyed hash of a key and its first 8 characters are stored, so the full key exists only in the answer of the
 * creation. A key that belongs to another merchant is `404`, like an unknown one, so a merchant cannot probe other ids. Merchant
 * routes write no audit row (B121); staff see the keys in `GET /admin/clients/:id/api-keys`.
 *
 * Side effects: writes `api_keys`; a change or a revocation drops the cached view of the key after the commit
 * (`ApiKeyDirectory.invalidate`), so it applies on the next call and not up to a minute later.
 *
 * @see docs/contract/MISMATCHES.md (B155)
 */
@Injectable()
export class MerchantApiKeyService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly directory: ApiKeyDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the merchant's keys: live keys first, then revoked ones.
   *
   * @param principal the signed-in merchant
   * @param request the range and the sort keys
   * @returns the keys in the range and the exact total
   */
  async list(principal: MerchantPrincipal, request: ApiKeyListRequest): Promise<{ rows: ApiKeyWire[]; total: number }> {
    const { rows, total } = await listKeysOfClient(this.db.db, principal.clientId, request);
    return { rows: rows.map(apiKeyToWire), total };
  }

  /**
   * Creates a key and returns it once.
   *
   * @param principal the signed-in merchant
   * @param input the name, the scopes, the allowed addresses and an optional expiry
   * @returns the stored key and the full key text
   * @throws {AppError} `VALIDATION_FAILED` (422) on `scopes.N` (an unknown scope), `allowedIps.N` (not an address or range),
   *   `expiresAt` (not in the future) or `name` (the merchant already holds 10 live keys)
   */
  async create(principal: MerchantPrincipal, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const scopes = checkScopes(input.scopes);
    const allowed = checkAllowedIps(input.allowedIps ?? []);
    const errors = [...(scopes.ok ? [] : scopes.errors), ...(allowed.ok ? [] : allowed.errors)];
    const now = this.clock.now();
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      errors.push({ field: 'expiresAt', code: 'in_the_past', message: 'Choose a time in the future.' });
    }
    if (errors.length > 0 || !scopes.ok || !allowed.ok) throw new AppError('VALIDATION_FAILED', { errors });

    const { key, prefix } = composeApiKey(this.tokens.random(32));
    const row = await this.db.runInTransaction(async ({ tx }) => {
      // Two requests at once would both see nine keys; the lock lets the second count after the first commits.
      await lockKeysOfClient(tx, principal.clientId);
      if ((await countLiveKeys(tx, principal.clientId, now)) >= MAX_LIVE_KEYS) {
        throw invalid('name', `You already have ${MAX_LIVE_KEYS} active keys; revoke one first.`);
      }
      return insertKey(tx, {
        clientId: principal.clientId,
        name: input.name,
        prefix,
        keyHash: this.tokens.hash(key),
        scopes: scopes.value,
        allowedIps: allowed.value,
        rateLimitPerMin: DEFAULT_RATE_LIMIT_PER_MIN,
        expiresAt,
      });
    });
    return { key: apiKeyToWire(row), secret: key };
  }

  /**
   * Renames a key or changes its allowed addresses.
   *
   * @param principal the signed-in merchant
   * @param id the key id
   * @param changes the fields to change; a missing one stays as it is
   * @returns the key after the change
   * @throws {AppError} `NOT_FOUND` (404: not the merchant's key, or unknown); `INVALID_TRANSITION` (409: the key is revoked);
   *   `VALIDATION_FAILED` (422) on `allowedIps.N`
   */
  async update(
    principal: MerchantPrincipal,
    id: number,
    changes: { readonly name?: string | undefined; readonly allowedIps?: readonly string[] | undefined },
  ): Promise<ApiKeyWire> {
    const allowed = changes.allowedIps === undefined ? undefined : checkAllowedIps(changes.allowedIps);
    if (allowed && !allowed.ok) throw new AppError('VALIDATION_FAILED', { errors: allowed.errors });
    return this.db.runInTransaction(async (work) => {
      const row = await lockKey(work.tx, id);
      if (!row || row.clientId !== principal.clientId) throw new AppError('NOT_FOUND', { detail: 'No such API key.' });
      if (row.revokedAt !== null) throw new AppError('INVALID_TRANSITION', { detail: 'This key is revoked.' });
      const updated = await updateKey(work.tx, id, {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(allowed?.ok ? { allowedIps: allowed.value } : {}),
      });
      // The cached view holds the allowed addresses: drop it so the change applies on the next call.
      await this.directory.invalidate([row.keyHash], work);
      return apiKeyToWire(updated);
    });
  }

  /**
   * Revokes a key.
   *
   * @param principal the signed-in merchant
   * @param id the key id
   * @throws {AppError} `NOT_FOUND` (404: not the merchant's key, or unknown). A key that is already revoked is not an error.
   */
  async revoke(principal: MerchantPrincipal, id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const row = await lockKey(work.tx, id);
      if (!row || row.clientId !== principal.clientId) throw new AppError('NOT_FOUND', { detail: 'No such API key.' });
      if (row.revokedAt !== null) return;
      await revokeKeyRow(work.tx, id, this.clock.now());
      await this.directory.invalidate([row.keyHash], work);
    });
  }
}
