// MerchantApiKeyService: the use cases of the merchant's own API keys (routes /client/api-keys, MISMATCHES B155): list, create
// (shown once), rename or change the allowed addresses, and revoke.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { sessionStateOf } from '../accounts/account-status';
import {
  type ApiKeyWire,
  DEFAULT_RATE_LIMIT_PER_MIN,
  MAX_LIVE_KEYS,
  apiKeyToWire,
  checkAllowedIps,
} from '../domain/api-key-input';
import {
  type ApiKeySortField,
  listKeysOfClient,
  lockKey,
  revokeKeyRow,
  updateKey,
} from '../infra/api-key-manage.repository';
import type { AccountPrincipal } from '../ports/account-principal';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';
import { ApiKeyIssuer } from './api-key-issuer';
import { MachineCredentialHold } from './machine-credential-hold';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';

/** The range and sort of a list request, already parsed and checked by the contract. */
export interface ApiKeyListRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sort: readonly { readonly field: ApiKeySortField; readonly order: 'asc' | 'desc' }[];
}

/** What a merchant sends to create a key. */
export interface CreateApiKeyInput {
  readonly name: string;
  readonly allowedIps?: readonly string[] | undefined;
  readonly expiresAt?: string | undefined;
}

/** The answer of a creation: the key as the lists show it, and the full key, shown this once. */
export interface CreatedApiKey {
  readonly key: ApiKeyWire;
  readonly secret: string;
}

/**
 * Manages the API keys of the signed-in merchant.
 *
 * Why: B155, decision 019 and decision 064. A key authenticates Dhru calls (P2.5c); the merchant creates, limits and revokes its
 * own. Only the keyed hash of a key and its first 8 characters are stored, so the full key exists only in the answer of the
 * creation. A key that belongs to another merchant is `404`, like an unknown one, so a merchant cannot probe other ids. Merchant
 * routes write no audit row (B121); staff see the keys in `GET /admin/clients/:id/api-keys`. A new key sends the merchant a notice that says
 * the key was made in the portal (`merchant.portal_api_key_created`; a key staff make sends the security notice that names the support team),
 * and no key is made while the account's password or email address is one staff set (`MachineCredentialHold`). The rank gate already
 * keeps a retail account off these routes; the creation checks the rank and the status again from the account row it holds locked
 * (`api-keys:<accountId>`, then the row `FOR UPDATE`), so a key cannot be born after a concurrent move to the retail rank.
 *
 * Side effects: writes `api_keys`; a creation also writes a `merchant.portal_api_key_created` notification and its outbox event; a change or a
 * revocation drops the cached view of the key after the commit (`ApiKeyDirectory.invalidate`), so it applies on the next call and not up
 * to a minute later.
 *
 * @see docs/contract/MISMATCHES.md (B155)
 */
@Injectable()
export class MerchantApiKeyService {
  constructor(
    private readonly db: DbService,
    private readonly issuer: ApiKeyIssuer,
    private readonly directory: ApiKeyDirectory,
    private readonly hold: MachineCredentialHold,
    private readonly lifecycleMails: MerchantLifecycleMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the merchant's keys: live keys first, then revoked ones.
   *
   * @param principal the signed-in account (a merchant rank: the gate refuses the others)
   * @param request the range and the sort keys
   * @returns the keys in the range and the exact total
   */
  async list(principal: AccountPrincipal, request: ApiKeyListRequest): Promise<{ rows: ApiKeyWire[]; total: number }> {
    const { rows, total } = await listKeysOfClient(this.db.db, principal.accountId, request);
    return { rows: rows.map(apiKeyToWire), total };
  }

  /**
   * Creates a key and returns it once.
   *
   * Why: the two locks come first and in the one order (the advisory lock `api-keys:<accountId>`, then the account row `FOR UPDATE`,
   * decision 064): a rank change that holds the row makes this creation wait, and the locked read then shows the new rank and refuses, so no
   * live key is left on a retail account. The hold on machine credentials is judged after, on the row this transaction holds.
   *
   * @param principal the signed-in account
   * @param input the name, the allowed addresses and an optional expiry
   * @returns the stored key and the full key text
   * @throws {AppError} `VALIDATION_FAILED` (422) on `allowedIps.N` (not an address or range),
   *   `expiresAt` (not in the future) or `name` (the account already holds 10 live keys); `RANK_NOT_ALLOWED` (403: the account is not of
   *   a merchant rank any more); `ACCOUNT_SUSPENDED` (403: suspended or blocked); `FORBIDDEN` (403: the account's password or
   *   email address is one staff set); `UNAUTHORIZED` (401: the account is erased, or the session ended meanwhile)
   */
  async create(principal: AccountPrincipal, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const issued = await this.db.runInTransaction(async (work) => {
      const account = await this.issuer.lockOwner(work.tx, principal.accountId);
      if (!account) throw new AppError('UNAUTHORIZED');
      // The same order as the sign-in gate: the status first, then the rank.
      const state = sessionStateOf(account.status);
      if (state === 'gone') throw new AppError('UNAUTHORIZED');
      if (state === 'suspended') throw new AppError('ACCOUNT_SUSPENDED');
      if (account.rankKind !== 'merchant') throw new AppError('RANK_NOT_ALLOWED');
      await this.hold.assertMayIssue(principal, work.tx);
      const key = await this.issuer.issue(work.tx, {
        clientId: account.id,
        name: input.name,
        allowedIps: input.allowedIps ?? [],
        expiresAt: input.expiresAt,
        rateLimitPerMin: DEFAULT_RATE_LIMIT_PER_MIN,
        createdBy: null,
        limitMessage: `You already have ${MAX_LIVE_KEYS} active keys; revoke one first.`,
      });
      await this.lifecycleMails.portalApiKeyCreated(work, account);
      return key;
    });
    return { key: apiKeyToWire(issued.row), secret: issued.secret };
  }

  /**
   * Renames a key or changes its allowed addresses.
   *
   * @param principal the signed-in account
   * @param id the key id
   * @param changes the fields to change; a missing one stays as it is
   * @returns the key after the change
   * @throws {AppError} `NOT_FOUND` (404: not the merchant's key, or unknown); `INVALID_TRANSITION` (409: the key is revoked);
   *   `VALIDATION_FAILED` (422) on `allowedIps.N`
   */
  async update(
    principal: AccountPrincipal,
    id: number,
    changes: { readonly name?: string | undefined; readonly allowedIps?: readonly string[] | undefined },
  ): Promise<ApiKeyWire> {
    const allowed = changes.allowedIps === undefined ? undefined : checkAllowedIps(changes.allowedIps);
    if (allowed && !allowed.ok) throw new AppError('VALIDATION_FAILED', { errors: allowed.errors });
    return this.db.runInTransaction(async (work) => {
      const row = await lockKey(work.tx, id);
      if (!row || row.clientId !== principal.accountId) throw new AppError('NOT_FOUND', { detail: 'No such API key.' });
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
   * @param principal the signed-in account
   * @param id the key id
   * @throws {AppError} `NOT_FOUND` (404: not the account's key, or unknown). A key that is already revoked is not an error.
   */
  async revoke(principal: AccountPrincipal, id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const row = await lockKey(work.tx, id);
      if (!row || row.clientId !== principal.accountId) throw new AppError('NOT_FOUND', { detail: 'No such API key.' });
      if (row.revokedAt !== null) return;
      await revokeKeyRow(work.tx, id, this.clock.now());
      await this.directory.invalidate([row.keyHash], work);
    });
  }
}
