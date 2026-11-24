// MerchantAccountReader: reads the signed-in account (of any rank) for the steps that must not trust the session's cached copy
// (decision 018). The class keeps its name: the merchant portal's services and the sign-in use cases of every account inject it.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { sessionStateOf } from '../accounts/account-status';
import type { Client } from '../db/schema';
import { findClientById } from '../infra/merchant-auth.repository';
import { SessionService } from '../security/session.service';

/**
 * Reads an account from the database for a sensitive step.
 *
 * Why: the session guard works from a view cached for up to 60 seconds. The code, password, 2FA and profile steps read the
 * account itself, so a suspension or a block applies at once: `403 ACCOUNT_SUSPENDED` and every session of the account ends
 * (ALIGNMENT § 3: session-ending codes describe the caller). What a status means for a session is read through `sessionStateOf`, never
 * by comparing words (decision 064).
 *
 * Side effects: an account that may not act (suspended or blocked) has all its sessions revoked.
 */
@Injectable()
export class MerchantAccountReader {
  constructor(
    private readonly db: DbService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Reads the account of a session.
   *
   * @param accountId the account id from the session
   * @returns the account row
   * @throws {AppError} `UNAUTHORIZED` (401) when the account no longer exists or was erased (`anonymized`), `ACCOUNT_SUSPENDED` (403)
   *   when it is suspended or blocked
   */
  async current(accountId: number): Promise<Client> {
    const client = await findClientById(this.db.db, accountId);
    if (!client) throw new AppError('UNAUTHORIZED');
    const state = sessionStateOf(client.status);
    // An erased account has no session left to end and answers as if it never existed.
    if (state === 'gone') throw new AppError('UNAUTHORIZED');
    if (state === 'suspended') {
      await this.sessions.revokeAllOf('account', client.id);
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended.' });
    }
    return client;
  }
}
