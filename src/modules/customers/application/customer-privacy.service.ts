// CustomerPrivacyService: GET /admin/customers/:id/export and POST /admin/customers/:id/anonymize (map domain I, stage 18, B49, B50,
// RESOLUTIONS b2c-4 and b2c-8): the data-subject access and erasure rights, carried out by staff.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { EncryptionService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { CUSTOMER_TOKEN_PURPOSES, CustomerAuthTokens, SessionService } from '../../identity';
import { AuditService } from '../../platform';
import { DataRequestService, IMEI_CHECK_AAD, ImeiErasure } from '../../risk';
import { CHECKOUT_IMEI_AAD } from '../domain/checkout';
import { buildCustomerExport } from '../domain/customer-export';
import { ANONYMIZED_NAME, anonymizedEmail, exportFilename } from '../domain/customer-privacy';
import { CustomerSignInFailures } from '../infra/customer-sign-in-failures';
import { findCustomerById, updateCustomerRow } from '../infra/customer.repository';
import {
  deleteCredentialsOf,
  eraseCheckoutSessions,
  eraseOrderImeis,
  exportRowsOf,
} from '../infra/privacy-reads.repository';
import { CustomerErasureHooks } from './customer-erasure-hooks';
import { customerNotFound } from './customer-errors';

/** The file an export answers with. */
export interface ExportFile {
  /** The name for `Content-Disposition`. */
  readonly filename: string;
  /** The JSON document, UTF-8. */
  readonly bytes: Buffer;
}

/**
 * Exports and anonymizes customers.
 *
 * Why: the privacy law gives a customer a right to a copy of their data and to its erasure (scenario b2c-account, B49, B50).
 * Export gathers everything the shop holds (see `buildCustomerExport`), works for any customer including an anonymized one, closes
 * the customer's open or in-progress export request (`completed`, with the time and the staff member) and audits `exported data of`;
 * it keeps no copy of the file. *Anonymize* is irreversible: the customer becomes `anonymized` with the name `Deleted customer` and the
 * address `deleted-<id>@redacted.invalid` (free for a new customer, ANSWERS customers Q10), the phone and notes go, marketing is off,
 * the account is closed (credentials deleted, sessions revoked, links voided), the IMEI of their orders, checkout sessions and IMEI
 * checks is cut to the TAC (or erased), the erasure request is completed, and the hooks of other modules run (the support ticket
 * link). Payments, ledger entries and amounts stay for accounting. The audit row names the customer by number, never by the old name.
 *
 * Side effects: export updates `data_requests` and inserts `audit_logs`. Anonymize updates `customers`, `orders`, `checkout_sessions`,
 * `imei_checks`, `data_requests`; deletes `customer_credentials`; revokes `sessions`; voids `auth_tokens`; inserts `audit_logs`; clears
 * the sign-in lockout of the old address after the commit.
 */
@Injectable()
export class CustomerPrivacyService {
  private readonly logger = new Logger(CustomerPrivacyService.name);

  constructor(
    private readonly db: DbService,
    private readonly encryption: EncryptionService,
    private readonly requests: DataRequestService,
    private readonly imeiErasure: ImeiErasure,
    private readonly sessions: SessionService,
    private readonly authTokens: CustomerAuthTokens,
    private readonly failures: CustomerSignInFailures,
    private readonly hooks: CustomerErasureHooks,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Builds the export file of a customer.
   *
   * @param staffId the signed-in staff member
   * @param id the customer id
   * @returns the file name and the JSON bytes
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async exportData(staffId: number, id: number): Promise<ExportFile> {
    const now = this.clock.now();
    return this.db.runInTransaction(async ({ tx }) => {
      const customer = await findCustomerById(tx, id);
      if (!customer) throw customerNotFound();
      // Close the waiting request first, so the file's own data-request list already shows it as completed.
      const closed = await this.requests.completePending(tx, id, 'export', staffId);
      const rows = await exportRowsOf(tx, id);
      const document = buildCustomerExport(customer, rows, now, (kind, ciphertext) => this.imeiOf(kind, ciphertext));
      await this.audit.record(tx, {
        action: 'exported data of',
        entityType: 'customer',
        entityId: id,
        entityLabel: customer.status === 'anonymized' ? `customer ${id}` : customer.name,
        before: { request: closed.length > 0 ? 'open' : 'none' },
        after: { request: 'exported' },
      });
      return { filename: exportFilename(id), bytes: Buffer.from(JSON.stringify(document, null, 2), 'utf8') };
    });
  }

  /**
   * Anonymizes a customer.
   *
   * @param staffId the signed-in staff member
   * @param id the customer id
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409, already anonymized)
   */
  async anonymize(staffId: number, id: number): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const customer = await findCustomerById(tx, id, true);
      if (!customer) throw customerNotFound();
      if (customer.status === 'anonymized') throw new AppError('ANONYMIZED');
      await updateCustomerRow(tx, id, {
        status: 'anonymized',
        anonymizedAt: now,
        name: ANONYMIZED_NAME,
        email: anonymizedEmail(id),
        emailVerifiedAt: null,
        phone: '',
        internalNotes: '',
        marketingOptIn: false,
        hasAccount: false,
        suspendedAt: null,
        suspendedBy: null,
        suspendedReason: null,
        updatedAt: now,
      });
      await deleteCredentialsOf(tx, id);
      await this.sessions.revokeAllOf('customer', id, {}, work);
      await this.authTokens.voidOpen(work, id, CUSTOMER_TOKEN_PURPOSES);
      await eraseOrderImeis(tx, id, now);
      await eraseCheckoutSessions(tx, id, anonymizedEmail(id), now);
      await this.imeiErasure.forCustomer(tx, id);
      await this.requests.completePending(tx, id, 'erasure', staffId);
      await this.hooks.run(tx, id);
      await this.audit.record(tx, {
        action: 'anonymised customer',
        entityType: 'customer',
        entityId: id,
        // The old name is personal data and the audit log is append-only: the entry names the customer by number.
        entityLabel: `customer ${id}`,
        before: { status: customer.status },
        after: { status: 'anonymized', name: ANONYMIZED_NAME, imei: 'removed (TAC kept)' },
      });
      work.afterCommit(() => this.failures.clear(customer.email));
    });
  }

  /** The digits of a stored IMEI, or `null` when it was erased or cannot be read. */
  private imeiOf(kind: 'checkout' | 'check', ciphertext: string | null): string | null {
    if (ciphertext === null) return null;
    try {
      return this.encryption.decrypt(ciphertext, kind === 'checkout' ? CHECKOUT_IMEI_AAD : IMEI_CHECK_AAD);
    } catch {
      this.logger.error('A stored IMEI could not be decrypted for a customer export.');
      return null;
    }
  }
}
