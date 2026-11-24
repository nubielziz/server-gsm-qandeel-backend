// ApiKeyAdminService: what staff do with an account's API keys (routes GET /admin/clients/:id/api-keys, POST /admin/clients/:id/api-keys,
// PATCH /admin/api-keys/:id and DELETE /admin/api-keys/:id): read them, create one, change its limits and revoke one, audited.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { canAct } from '../accounts/account-status';
import {
  type ApiKeyWire,
  DEFAULT_RATE_LIMIT_PER_MIN,
  MAX_LIVE_KEYS,
  apiKeyToWire,
  checkAllowedIps,
  classifyKeyChange,
} from '../domain/api-key-input';
import {
  accountNameOf,
  listAllKeysOfClient,
  lockKey,
  revokeKeyRow,
  updateKey,
} from '../infra/api-key-manage.repository';
import { requireOwner } from '../security/principal';
import type { StaffPrincipal } from '../security/principal';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';
import { ApiKeyIssuer } from './api-key-issuer';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';

/** The refusal text when a staff member who is not an Owner widens a key (decision 046). */
const WIDEN_KEY_DETAIL = 'Only an owner can widen the allowed addresses of an API key or raise its limit.';

/** What staff send to create a key for a merchant. */
export interface CreateClientApiKeyInput {
  readonly name: string;
  readonly allowedIps?: readonly string[] | undefined;
  readonly expiresAt?: string | undefined;
  readonly rateLimitPerMin?: number | undefined;
}

/** The answer of a creation: the key as the lists show it, and the full key, shown this once. */
export interface CreatedClientApiKey {
  readonly key: ApiKeyWire;
  readonly secret: string;
}

/**
 * Lets staff read, create, limit and revoke the API keys of accounts.
 *
 * Why: the Accounts page lists an account's keys with their last use, revokes one that leaked or is no longer wanted
 * (map rows `GET /admin/clients/:id/api-keys`, `DELETE /admin/api-keys/:id`, MISMATCHES B31) and, since feature 20 (O-9), creates a key
 * for an active account of a merchant rank (`api_keys:create` and an Owner, decision 046; shown once, recorded in `api_keys.created_by`, the
 * merchant is mailed) and changes a key's per-minute limit and allowed addresses (`api_keys:update`). Every change is effective at once: the
 * cached view of the key is dropped after the commit (P2.5c), and each one writes an audit row under the account (decision 064: the audit
 * entity is `account`). The keys of an account that left the merchant rank stay readable (revoked), but no key is made for it.
 *
 * Side effects: `create` takes the `api-keys:<accountId>` advisory lock and then the account row `FOR UPDATE`, inserts `api_keys`, a
 * `merchant.security_notice` notification and an audit row (never the key); `update` writes `api_keys`, an audit row and, when a value
 * changes, a `merchant.security_notice` notification; `revoke` sets `api_keys.revoked_at` and writes `audit_logs` (`revoked API key
 * of`, entity `account`); `update` and `revoke` drop the cached view of the key after the commit.
 *
 * @see docs/contract/endpoints/identity.md (the api-keys sections)
 */
@Injectable()
export class ApiKeyAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly directory: ApiKeyDirectory,
    private readonly issuer: ApiKeyIssuer,
    private readonly lifecycleMails: MerchantLifecycleMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists every key of an account, newest first.
   *
   * @param clientId the account id
   * @returns the keys, revoked and expired included (an account that left the merchant rank shows the keys it had, all revoked)
   * @throws {AppError} `NOT_FOUND` (404) when no account has the id
   */
  async list(clientId: number): Promise<ApiKeyWire[]> {
    if ((await accountNameOf(this.db.db, clientId)) === undefined) {
      throw new AppError('NOT_FOUND', { detail: 'No account has this id.' });
    }
    return (await listAllKeysOfClient(this.db.db, clientId)).map(apiKeyToWire);
  }

  /**
   * Creates a key for an active account of a merchant rank and returns it once.
   *
   * Why: the two locks come first and in the one order, like the merchant's own creation (the advisory lock `api-keys:<accountId>`, then
   * the account row `FOR UPDATE`, decision 064): a rank change to retail that holds the row makes this creation wait, and the locked read
   * then shows the retail rank and refuses, so no live key is left on a retail account.
   *
   * @param caller the signed-in staff member
   * @param clientId the account id
   * @param input the name, allowed addresses, expiry and per-minute limit
   * @returns the stored key (`createdByStaff: true`) and the full key text
   * @throws {AppError} `FORBIDDEN` (403: only an Owner creates a key for a merchant, decision 046), `NOT_FOUND` (404), `CONFLICT`
   *   (409: the account is not of a merchant rank, so a key could not be used), `NOT_ACTIVE` (409: the account is suspended, blocked or
   *   erased, so the key could not be used), `VALIDATION_FAILED` (422) on `allowedIps.N`, `expiresAt`, `rateLimitPerMin` or `name`
   *   (10 live keys already)
   */
  async create(caller: StaffPrincipal, clientId: number, input: CreateClientApiKeyInput): Promise<CreatedClientApiKey> {
    // Decision 046: a key that spends a merchant's money is made by the merchant, or by an Owner.
    requireOwner(caller, 'Only an owner can create an API key for a merchant.');
    return this.db.runInTransaction(async (work) => {
      // Lock order (the one named exception of the lock order, decision 064): the key lock first, then the account row, both taken by the
      // issuer. The merchant's own creation takes them in the same order; the rank change and the erasure hold the row and revoke the keys
      // without the key lock, so no cycle can form.
      const account = await this.issuer.lockOwner(work.tx, clientId);
      if (!account) throw new AppError('NOT_FOUND', { detail: 'No account has this id.' });
      if (account.rankKind !== 'merchant') {
        throw new AppError('CONFLICT', { detail: 'Only an account of a merchant rank can have an API key.' });
      }
      if (!canAct(account.status)) {
        throw new AppError('NOT_ACTIVE', {
          detail: 'Only an active account can have an API key. Reactivate the account first.',
        });
      }
      const { row, secret } = await this.issuer.issue(work.tx, {
        clientId,
        name: input.name,
        allowedIps: input.allowedIps ?? [],
        expiresAt: input.expiresAt,
        rateLimitPerMin: input.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN,
        createdBy: caller.staffId,
        limitMessage: `This merchant already has ${MAX_LIVE_KEYS} active keys; revoke one first.`,
      });
      await this.lifecycleMails.securityNotice(work, account, 'api_key_created');
      await this.audit.record(work.tx, {
        action: 'created API key for',
        entityType: 'account',
        entityId: clientId,
        entityLabel: account.name,
        // Never the key: only what identifies it.
        after: {
          keyId: row.id,
          name: row.name,
          prefix: row.prefix,
          allowedIps: row.allowedIps,
          rateLimitPerMin: row.rateLimitPerMin,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      });
      return { key: apiKeyToWire(row), secret };
    });
  }

  /**
   * Changes a key's per-minute limit and allowed addresses.
   *
   * Why: a change that gives the key more reach (an empty list, an address that was not stored, a higher limit) is kept for Owners, like
   * the creation of a key (decision 046); the other staff may narrow a key. The judgement is made on the row this transaction holds, so
   * a concurrent change cannot make a stale read pass. The merchant is mailed a security notice for every change that alters a value.
   *
   * @param caller the signed-in staff member
   * @param id the key id
   * @param changes the new limit and/or the new address list (`[]` removes the restriction); a missing one stays
   * @returns the key after the change
   * @throws {AppError} `NOT_FOUND` (404), `ALREADY_REVOKED` (409), `FORBIDDEN` (403: the change widens the key and the caller is not an
   *   Owner), `VALIDATION_FAILED` (422) on `allowedIps.N`
   */
  async update(
    caller: StaffPrincipal,
    id: number,
    changes: { readonly rateLimitPerMin?: number | undefined; readonly allowedIps?: readonly string[] | undefined },
  ): Promise<ApiKeyWire> {
    const allowed = changes.allowedIps === undefined ? undefined : checkAllowedIps(changes.allowedIps);
    if (allowed && !allowed.ok) throw new AppError('VALIDATION_FAILED', { errors: allowed.errors });
    return this.db.runInTransaction(async (work) => {
      const row = await lockKey(work.tx, id);
      if (!row) throw new AppError('NOT_FOUND', { detail: 'No API key has this id.' });
      if (row.revokedAt !== null) throw new AppError('ALREADY_REVOKED', { detail: 'This key was revoked.' });
      // The kind is judged against the locked row; a widening needs an Owner and nothing has been written yet.
      const kind = classifyKeyChange(row, {
        rateLimitPerMin: changes.rateLimitPerMin,
        allowedIps: allowed?.ok ? allowed.value : undefined,
      });
      if (kind === 'widens') requireOwner(caller, WIDEN_KEY_DETAIL);
      const updated = await updateKey(work.tx, id, {
        ...(changes.rateLimitPerMin === undefined ? {} : { rateLimitPerMin: changes.rateLimitPerMin }),
        ...(allowed?.ok ? { allowedIps: allowed.value } : {}),
      });
      // The cached view holds both values: drop it so the change applies on the next call.
      await this.directory.invalidate([row.keyHash], work);
      const merchantName = (await accountNameOf(work.tx, row.clientId)) ?? `Account ${row.clientId}`;
      if (kind !== 'none') {
        await this.lifecycleMails.securityNotice(work, { id: row.clientId, name: merchantName }, 'api_key_changed');
      }
      const facts = (key: typeof row) => ({
        keyId: key.id,
        name: key.name,
        prefix: key.prefix,
        rateLimitPerMin: key.rateLimitPerMin,
        allowedIps: key.allowedIps,
      });
      await this.audit.record(work.tx, {
        action: 'changed limits of API key of',
        entityType: 'account',
        entityId: row.clientId,
        entityLabel: merchantName,
        before: facts(row),
        after: facts(updated),
      });
      return apiKeyToWire(updated);
    });
  }

  /**
   * Revokes a key.
   *
   * @param id the key id
   * @throws {AppError} `NOT_FOUND` (404) for an unknown key; `ALREADY_REVOKED` (409) for a key that was revoked before
   */
  async revoke(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const row = await lockKey(work.tx, id);
      if (!row) throw new AppError('NOT_FOUND', { detail: 'No API key has this id.' });
      if (row.revokedAt !== null) throw new AppError('ALREADY_REVOKED', { detail: 'This key was already revoked.' });
      await revokeKeyRow(work.tx, id, this.clock.now());
      await this.directory.invalidate([row.keyHash], work);
      await this.audit.record(work.tx, {
        action: 'revoked API key of',
        entityType: 'account',
        entityId: row.clientId,
        entityLabel: (await accountNameOf(work.tx, row.clientId)) ?? `Account ${row.clientId}`,
        before: { keyId: row.id, name: row.name, prefix: row.prefix, revoked: false },
        after: { keyId: row.id, name: row.name, prefix: row.prefix, revoked: true },
      });
    });
  }
}
