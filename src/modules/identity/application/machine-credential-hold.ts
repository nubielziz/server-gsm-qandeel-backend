// MachineCredentialHold: whether the signed-in merchant may hand out a machine credential now (an API key, or a webhook endpoint with its
// signing secret, routes POST /client/api-keys, POST /client/webhooks and PATCH /client/webhooks/:id): not while the account's password or
// email address is one staff set (decision 046).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import type { Client } from '../db/schema';
import { findClientById } from '../infra/merchant-auth.repository';
import type { MerchantPrincipal } from '../security/principal';
import { findLiveSessionByHash } from '../security/session.repository';

/** The sentence of the `403` while the hold lasts: what the merchant does to end it. */
export const STAFF_SET_PASSWORD_HOLD =
  'Your password was set by our support team. Set a new one from a link sent to your email address (Forgot password on the ' +
  'sign-in page) before you create API keys or webhook endpoints.';

/** The sentence of the `403` while the hold of an email address staff set lasts. */
export const STAFF_SET_EMAIL_HOLD =
  'Your email address was changed by our support team. Contact our support team before you create API keys or webhook endpoints.';

/**
 * Refuses machine credentials while the merchant's password or email address is one staff set.
 *
 * Why: decision 046 keeps the creation of a merchant's API key by staff for Owners; merchants create their own. A temporary password
 * is shared with staff, so a session that started from it (the forced change included) does not show that the owner of the mailbox is
 * the one asking, and an API key or a webhook endpoint outlives every later password change. While `clients.password_set_by_staff` holds (from a staff
 * temporary password until the merchant chooses a password from a link mailed to its address), a portal session creates no API key and
 * creates or changes no webhook endpoint; signing in and the rest of the portal work. The same holds while `clients.email_set_by_staff`
 * is set (from a staff change of the email address): the account's reset and invitation links then go to an address staff chose, so a
 * password from such a link does not end that hold.
 *
 * Side effects: none (it reads `clients` and `sessions`).
 *
 * @see docs/decisions/046-privilege-ceiling.md
 */
@Injectable()
export class MachineCredentialHold {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Checks that the signed-in merchant may create a machine credential now.
   *
   * Why: the session guard works from a view cached for up to a minute; this reads the account and the session themselves (decision 018).
   *
   * @param principal the signed-in merchant
   * @param db the caller's transaction, or the database when omitted
   * @returns the merchant as it is now
   * @throws {AppError} `UNAUTHORIZED` (401: the merchant is gone, or the session ended meanwhile), `FORBIDDEN` (403: the password is
   *   one staff set, {@link STAFF_SET_PASSWORD_HOLD}; or the email address is one staff set, {@link STAFF_SET_EMAIL_HOLD})
   */
  async assertMayIssue(principal: MerchantPrincipal, db: DbExecutor = this.db.db): Promise<Client> {
    const client = await findClientById(db, principal.clientId);
    if (!client) throw new AppError('UNAUTHORIZED');
    // Read after the account on purpose: the link that clears the flag ends every session of the merchant in the same commit, so once the
    // cleared flag is visible, so is the end of the sessions that were open under it.
    if (!(await findLiveSessionByHash(db, principal.session.tokenHash, this.clock.now()))) {
      throw new AppError('UNAUTHORIZED');
    }
    // The email cause first: a password from a link does not end it, so its sentence is the one that helps.
    if (client.emailSetByStaff) throw new AppError('FORBIDDEN', { detail: STAFF_SET_EMAIL_HOLD });
    if (client.passwordSetByStaff) throw new AppError('FORBIDDEN', { detail: STAFF_SET_PASSWORD_HOLD });
    return client;
  }
}
