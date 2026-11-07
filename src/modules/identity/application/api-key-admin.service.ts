// ApiKeyAdminService: what staff do with a merchant's API keys (routes GET /admin/clients/:id/api-keys and
// DELETE /admin/api-keys/:id): read them and revoke one, audited.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type ApiKeyWire, apiKeyToWire } from '../domain/api-key-input';
import { listAllKeysOfClient, lockKey, merchantNameOf, revokeKeyRow } from '../infra/api-key-manage.repository';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';

/**
 * Lets staff read and revoke the API keys of merchants.
 *
 * Why: the merchants tab of the console lists a merchant's keys with their last use and revokes one that leaked or is no longer
 * wanted (map rows `GET /admin/clients/:id/api-keys`, `DELETE /admin/api-keys/:id`, MISMATCHES B31). There is no admin route to
 * create or rotate a key: merchants make their own (M45). A revocation is effective at once: the cached view of the key is
 * dropped after the commit (P2.5c), and the audit entry reads like the demo's `rotated API key of <merchant>`.
 *
 * Side effects: `revoke` sets `api_keys.revoked_at`, writes `audit_logs` (`revoked API key of`, entity `merchant`) and drops the
 * cached view of the key after the commit.
 *
 * @see docs/contract/endpoints/identity.md (GET /admin/clients/:id/api-keys, DELETE /admin/api-keys/:id)
 */
@Injectable()
export class ApiKeyAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly directory: ApiKeyDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists every key of a merchant, newest first.
   *
   * @param clientId the merchant id
   * @returns the keys, revoked and expired included
   * @throws {AppError} `NOT_FOUND` (404) when no merchant has the id
   */
  async list(clientId: number): Promise<ApiKeyWire[]> {
    if ((await merchantNameOf(this.db.db, clientId)) === undefined) {
      throw new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
    }
    return (await listAllKeysOfClient(this.db.db, clientId)).map(apiKeyToWire);
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
        entityType: 'merchant',
        entityId: row.clientId,
        entityLabel: (await merchantNameOf(work.tx, row.clientId)) ?? `Merchant ${row.clientId}`,
        before: { keyId: row.id, name: row.name, prefix: row.prefix, revoked: false },
        after: { keyId: row.id, name: row.name, prefix: row.prefix, revoked: true },
      });
    });
  }
}
