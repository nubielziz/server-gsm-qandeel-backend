// ApiKeyIssuer: the one place that locks the owner of a new API key, checks and stores it, shared by the merchant's own creation
// (POST /client/api-keys) and the staff's (POST /admin/clients/:id/api-keys, feature 20).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { TokenService } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import { type AccountRecord, AccountDirectory } from '../accounts/account-directory';
import { MAX_LIVE_KEYS, checkAllowedIps, composeApiKey } from '../domain/api-key-input';
import { countLiveKeys, insertKey, lockKeysOfClient } from '../infra/api-key-manage.repository';
import type { ApiKey } from '../db/schema';

/** What the issuer needs to make a key. */
export interface IssueApiKeyInput {
  /** The account that holds the key (`api_keys.client_id` already names the account). */
  readonly clientId: number;
  readonly name: string;
  readonly allowedIps: readonly string[];
  /** ISO time in the future, or `undefined` for a key that never expires. */
  readonly expiresAt: string | undefined;
  readonly rateLimitPerMin: number;
  /** The staff member who creates the key; null for a key the merchant makes. */
  readonly createdBy: number | null;
  /** The sentence of the `422` on `name` when the merchant already holds {@link MAX_LIVE_KEYS} live keys (it differs by caller). */
  readonly limitMessage: string;
}

/** A stored key and the full key text, which exists only here. */
export interface IssuedApiKey {
  readonly row: ApiKey;
  readonly secret: string;
}

/**
 * Locks the owner of a new API key, checks it and stores it.
 *
 * Why: B155, feature 20 (R5) and decision 064: the merchant and staff create keys under the same rules (valid addresses, an expiry
 * in the future, at most 10 live keys per account, decision 019 for the secret), so the rules live once. Only the keyed hash of the
 * key and its first 8 characters are stored; the clear key is returned to the caller, which hands it to the person once. The two locks of
 * a creation are taken in one place and in one order (`lockOwner`): the advisory lock `api-keys:<accountId>` first, then the account row
 * `FOR UPDATE`. A rank change or an erasure holds the account row and revokes the keys without that advisory lock, so a creation that
 * waited behind it reads the new rank from its locked read and refuses: no key is born on an account that is no longer a merchant (the one
 * named exception to the order of locks, decision 064).
 *
 * Side effects: `lockOwner` takes the `api-keys:<accountId>` advisory lock and the account row lock until the caller's transaction ends
 * (two creations at once cannot both pass the count); `issue` inserts an `api_keys` row.
 */
@Injectable()
export class ApiKeyIssuer {
  constructor(
    private readonly tokens: TokenService,
    private readonly accounts: AccountDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Takes the two locks of a key creation and reads the account from the locked row.
   *
   * Why: the caller judges the rank and the status on this read, never on a session's cached copy, and the row stays locked until the key
   * is stored, so the judgement cannot go stale. The order is fixed: the advisory lock, then the row.
   *
   * @param tx the caller's transaction (nothing of the account may have been read with a lock before)
   * @param accountId the account that will hold the key
   * @returns the account as it is now, or `undefined` when there is none
   */
  async lockOwner(tx: DbExecutor, accountId: number): Promise<AccountRecord | undefined> {
    await lockKeysOfClient(tx, accountId);
    return this.accounts.lockForUpdate(tx, accountId);
  }

  /**
   * Validates the input, counts the live keys under the lock and inserts the key.
   *
   * @param tx the caller's transaction (after `lockOwner`; the advisory lock is taken again, which is free inside one transaction)
   * @param input the key's name, addresses, expiry, limit and who creates it
   * @returns the stored row and the full key
   * @throws {AppError} `VALIDATION_FAILED` (422) on `allowedIps.N`, `expiresAt` (not in the future) or `name` (10 live
   *   keys already)
   */
  async issue(tx: DbExecutor, input: IssueApiKeyInput): Promise<IssuedApiKey> {
    const allowed = checkAllowedIps(input.allowedIps);
    const errors = allowed.ok ? [] : [...allowed.errors];
    const now = this.clock.now();
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      errors.push({ field: 'expiresAt', code: 'in_the_past', message: 'Choose a time in the future.' });
    }
    if (errors.length > 0 || !allowed.ok) throw new AppError('VALIDATION_FAILED', { errors });

    const { key, prefix } = composeApiKey(this.tokens.random(32));
    // Two requests at once would both see nine keys; the lock lets the second count after the first commits.
    await lockKeysOfClient(tx, input.clientId);
    if ((await countLiveKeys(tx, input.clientId, now)) >= MAX_LIVE_KEYS) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'name', code: 'invalid', message: input.limitMessage }],
      });
    }
    const row = await insertKey(tx, {
      clientId: input.clientId,
      name: input.name,
      prefix,
      keyHash: this.tokens.hash(key),
      allowedIps: allowed.value,
      rateLimitPerMin: input.rateLimitPerMin,
      expiresAt,
      createdBy: input.createdBy,
    });
    return { row, secret: key };
  }
}
