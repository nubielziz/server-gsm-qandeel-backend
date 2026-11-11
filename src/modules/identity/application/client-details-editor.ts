// ClientDetailsEditor: the "details" kind of PATCH /admin/clients/:id (feature 20): staff edit a merchant's profile and email.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { type TransactionContext, isUniqueViolation } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { AuditService } from '../../platform';
import type { Client } from '../db/schema';
import { accountMailKey } from '../domain/account-mail';
import { type ClientChangeInput, detailChanges } from '../domain/client-details';
import { updateClientRow } from '../infra/client-admin.repository';
import { CLIENT_TOKEN_PURPOSES, voidOpenClientTokens } from '../infra/merchant-token.repository';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';
import type { StaffPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import { MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { MerchantAuthTokens } from './merchant-auth-tokens';

/**
 * Applies a staff edit of a merchant's details.
 *
 * Why: LEAD-DECISIONS section 6 (merchant management): staff change name, company, phone, country, language, address, tax id, internal
 * notes and the email (plan sections 4.1 and 5.1.2). An email change voids every open link (a verification link carries no email snapshot, so
 * an old one would prove the new address), clears the verification and sends a new verification (or the invitation while there is no password)
 * to the new address; the merchant's sessions stay (O-3).
 *
 * Side effects: writes `clients`, `auth_tokens`, `outbox_events` (`merchant.email_verification` or `merchant.invited`, ids only) and
 * `audit_logs`; drops the cached session and API key views of the merchant after the commit when the name or email changed; the email
 * change counts one point of the `account-mail` limiter.
 */
@Injectable()
export class ClientDetailsEditor {
  constructor(
    private readonly tokens: MerchantAuthTokens,
    private readonly mail: MerchantMailOutbox,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyDirectory,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Spends one `account-mail` point for an email change. Called before the transaction, after the cheap refusals, so a refused call spends none.
   *
   * @param clientId the merchant id
   * @throws {AppError} `RATE_LIMITED` (429)
   */
  async enforceEmailChangeLimit(clientId: number): Promise<void> {
    await this.limits.enforce('account-mail', accountMailKey('client', clientId, 'email_change'));
  }

  /**
   * Applies the edit inside the caller's transaction (the merchant row is already locked).
   *
   * @param work the caller's transaction
   * @param caller the signed-in staff member
   * @param client the locked merchant row
   * @param input the body of the edit
   * @throws {AppError} `VALIDATION_FAILED` (422 on `name`), `EMAIL_TAKEN` (409)
   */
  async apply(
    work: TransactionContext,
    caller: StaffPrincipal,
    client: Client,
    input: ClientChangeInput,
  ): Promise<void> {
    const changes = detailChanges(client, input);
    if ('problem' in changes) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: changes.problem.field, code: 'invalid', message: changes.problem.message }],
      });
    }
    const after: Record<string, unknown> = { ...changes.after };
    if (Object.keys(changes.columns).length > 0) {
      try {
        await updateClientRow(work.tx, client.id, {
          ...changes.columns,
          ...(changes.emailChanged ? { emailVerifiedAt: null } : {}),
        });
      } catch (error) {
        if (isUniqueViolation(error, 'clients_email_uq')) {
          throw new AppError('EMAIL_TAKEN', {
            detail: `A merchant with ${changes.columns.email ?? 'this address'} already exists.`,
            errors: [{ field: 'email', code: 'EMAIL_TAKEN', message: 'Another merchant uses this email address.' }],
          });
        }
        throw error;
      }
    }
    if (changes.emailChanged) {
      after.emailVerified = false;
      await this.sendNewAddressMail(work, caller, client);
    }
    if (changes.emailChanged || changes.nameChanged) {
      // Both cached views hold the name (and the API key view the status): drop them after the commit.
      await this.sessions.invalidateSubject('client', client.id, work);
      await this.apiKeys.invalidateClient(client.id, work);
    }
    await this.audit.record(work.tx, {
      action: 'edited details of',
      entityType: 'merchant',
      entityId: client.id,
      entityLabel: changes.columns.name ?? client.name,
      before: changes.before,
      after,
    });
  }

  /** Voids every open link, then mails the new address a verification (or the invitation while there is no password). */
  private async sendNewAddressMail(work: TransactionContext, caller: StaffPrincipal, client: Client): Promise<void> {
    await voidOpenClientTokens(work.tx, client.id, CLIENT_TOKEN_PURPOSES, this.clock.now());
    // A suspended merchant gets nothing: every link of theirs is dead anyway, and a reactivation does not send one.
    if (client.status === 'suspended') return;
    const invited = client.passwordHash === null;
    const issued = await this.tokens.issue(work, {
      clientId: client.id,
      purpose: invited ? 'invite' : 'verify_email',
      createdBy: caller.staffId,
      ip: caller.ip,
    });
    await this.mail.enqueue(work, {
      kind: invited ? 'invited' : 'email_verification',
      clientId: client.id,
      tokenId: issued.id,
    });
  }
}
