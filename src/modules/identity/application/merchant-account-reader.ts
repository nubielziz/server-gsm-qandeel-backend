// MerchantAccountReader: reads the signed-in merchant for the steps that must not trust the session's cached copy (decision 018).
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { Client } from '../db/schema';
import { findClientById } from '../infra/merchant-auth.repository';
import { SessionService } from '../security/session.service';

/**
 * Reads a merchant from the database for a sensitive step.
 *
 * Why: the session guard works from a view cached for up to 60 seconds. The code, password, 2FA and profile steps read the
 * account itself, so a suspension applies at once: `403 ACCOUNT_SUSPENDED` and every session of the merchant ends
 * (ALIGNMENT § 3: session-ending codes describe the caller).
 *
 * Side effects: a suspended merchant has all its sessions revoked.
 */
@Injectable()
export class MerchantAccountReader {
  constructor(
    private readonly db: DbService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Reads the merchant of a session.
   *
   * @param clientId the merchant id from the session
   * @returns the merchant row (a `pending` merchant is fine: B153 lets it manage its own account)
   * @throws {AppError} `UNAUTHORIZED` (401) when the merchant no longer exists, `ACCOUNT_SUSPENDED` (403) when it is suspended
   */
  async current(clientId: number): Promise<Client> {
    const client = await findClientById(this.db.db, clientId);
    if (!client) throw new AppError('UNAUTHORIZED');
    if (client.status === 'suspended') {
      await this.sessions.revokeAllOf('client', client.id);
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended.' });
    }
    return client;
  }
}
