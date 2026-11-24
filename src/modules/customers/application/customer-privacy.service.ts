// CustomerPrivacyService: GET /admin/clients/:id/export and POST /admin/clients/:id/anonymize (map domain I, stage 18, B49, B50,
// RESOLUTIONS b2c-4 and b2c-8; decision 064): the data-subject access and erasure rights, carried out by staff, for an account of any rank
// (the erasure for the retail rank only).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { EncryptionService } from '../../../infra/crypto';
import { type DbExecutor, DbService, type TransactionContext } from '../../../infra/db';
import { AccountAccessEffects, AccountDirectory, type AccountRecord, SignInLock } from '../../identity';
import { CustomerWallets, WalletErasure, invoiceWireSide } from '../../money';
import { AuditService } from '../../platform';
import { DataRequestService } from '../../risk';
import { CHECKOUT_IMEI_AAD } from '../domain/checkout';
import { buildAccountExport } from '../domain/customer-export';
import {
  ANONYMIZED_NAME,
  anonymizedEmail,
  coversGuestRow,
  exportFilename,
  guestRowOpenText,
  holdsMerchantPart,
} from '../domain/customer-privacy';
import { type AccountRow, findCustomerById, updateCustomerRow } from '../infra/customer.repository';
import {
  eraseCheckoutSessions,
  eraseOrderImeis,
  exportRowsOf,
  merchantExportOf,
  openObligationsOf,
  rankNameOf,
} from '../infra/privacy-reads.repository';
import { AccountErasureHooks } from './customer-erasure-hooks';
import { accountNotFound } from './customer-errors';

/** The file an export answers with. */
export interface ExportFile {
  /** The name for `Content-Disposition`. */
  readonly filename: string;
  /** The JSON document, UTF-8. */
  readonly bytes: Buffer;
}

/** The transaction a use case works in. */
type Work = Pick<TransactionContext, 'tx' | 'afterCommit'>;

/** The words of the refusal to erase a merchant rank (its wallet, hold, credit and keys are settled by the rank change first). */
const MERCHANT_RANK_TEXT = 'Move the account to the retail rank first.';

/**
 * Exports and anonymizes accounts.
 *
 * Why: the privacy law gives a person a right to a copy of their data and to its erasure (scenario b2c-account, B49, B50). Export gathers
 * everything the shop holds (see `buildAccountExport`), works for any account including an anonymized one, closes the account's open or
 * in-progress export request (`completed`, with the time and the staff member) and audits `exported data of`; it keeps no copy of the
 * file. *Anonymize* is irreversible and for the retail rank only (`409 CONFLICT`, "Move the account to the retail rank first.", for a
 * merchant rank: its wallet, hold, credit and keys are settled by the rank change first): the account becomes `anonymized` with the name
 * `Deleted account` and the address `deleted-account-<id>@redacted.invalid` (a pattern no old customer number can collide with), the
 * phone, notes, company, address and tax id go, marketing is off, the account is closed (the password, the two-step secret and the Dhru
 * username of an account that once held a merchant rank are cleared, sessions end, keys stop, links are voided: `AccountAccessEffects`), the IMEI of its orders and checkout sessions is cut to the
 * TAC (or erased), the erasure request is completed, and the hooks of other modules run (the support ticket link, the inbox). Payments,
 * ledger entries and amounts stay for accounting. The audit row names the account by number, never by the old name.
 *
 * When the account is retail, has a login and its email was proven (`email_verified_at`), the guest row of that email is
 * the same person's earlier shopping. The export lists it in its own section, and the anonymization erases it in the same transaction with
 * the same steps: lock order, the account row first and then the guest row (decision 064); the guest row keeps its id and becomes
 * `anonymized` with `deleted-account-<guestId>@redacted.invalid`. An open checkout or a pending payment of the guest row refuses the
 * whole erasure with `409 CONFLICT` and its reason; nothing is written then.
 *
 * Side effects: export updates `data_requests` and inserts `audit_logs`. Anonymize updates `clients`, `orders`, `checkout_sessions`,
 * `data_requests`; ends `sessions`, revokes `api_keys` and voids `auth_tokens` (through the access effects); inserts `audit_logs`;
 * clears the sign-in lockout of the old address after the commit. Feature 21: anonymize is refused while the store balance is not zero or
 * money is in flight (a top-up, an open order paid from the balance, a refund to the balance waiting for staff), and voids the unpaid
 * top-ups; the export holds every wallet of the account that has entries (the merchant wallet and the store balance, each with its
 * statement), whatever the rank is today, and the wallet of today's rank always.
 */
@Injectable()
export class CustomerPrivacyService {
  private readonly logger = new Logger(CustomerPrivacyService.name);

  constructor(
    private readonly db: DbService,
    private readonly encryption: EncryptionService,
    private readonly requests: DataRequestService,
    private readonly effects: AccountAccessEffects,
    private readonly directory: AccountDirectory,
    private readonly lock: SignInLock,
    private readonly hooks: AccountErasureHooks,
    private readonly audit: AuditService,
    private readonly wallets: CustomerWallets,
    private readonly walletErasure: WalletErasure,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Builds the export file of an account.
   *
   * @param staffId the signed-in staff member
   * @param id the account id (any rank, any status)
   * @returns the file name and the JSON bytes
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async exportData(staffId: number, id: number): Promise<ExportFile> {
    const now = this.clock.now();
    return this.db.runInTransaction(async ({ tx }) => {
      const account = await this.directory.findById(tx, id);
      const row = await findCustomerById(tx, id);
      if (!account || !row) throw accountNotFound();
      const rank = await rankNameOf(tx, row.groupId);
      // Close the waiting request first, so the file's own data-request list already shows it as completed.
      const closed = await this.requests.completePending(tx, id, 'export', staffId);
      const rows = await exportRowsOf(tx, id);
      const guest = coversGuestRow(account) ? await this.guestRowOf(tx, account) : undefined;
      const guestRows = guest ? await exportRowsOf(tx, guest.id) : undefined;
      // Every wallet of the account that has entries, whatever the rank is today: an account that was retail and is a merchant now (or
      // the other way round) still gets the history of its earlier wallet, each wallet in its own section. The wallet of today's rank is
      // always there, empty or not. An account that held a merchant rank keeps its API keys and merchant invoices in the file, whatever
      // its merchant wallet holds.
      const merchantPart = await merchantExportOf(tx, id);
      const merchant = holdsMerchantPart({
        rankKind: account.rankKind,
        walletLines: merchantPart.wallet?.lines.length ?? 0,
        apiKeys: merchantPart.apiKeys.length,
        merchantInvoices: merchantPart.invoices.filter((invoice) => invoiceWireSide(invoice) === 'client').length,
      })
        ? merchantPart
        : undefined;
      const storePart = await this.wallets.exportOf(tx, id);
      const wallet = account.rankKind === 'retail' || storePart.entries.length > 0 ? storePart : undefined;
      const document = buildAccountExport({
        account: row,
        rank: { id: row.groupId, name: rank?.name ?? '', kind: account.rankKind },
        rows,
        ...(guest && guestRows ? { guest: { email: guest.email, rows: guestRows } } : {}),
        ...(merchant ? { merchant } : {}),
        ...(wallet ? { wallet } : {}),
        exportedAt: now,
        imeiOf: (ciphertext) => this.imeiOf(ciphertext),
      });
      await this.audit.record(tx, {
        action: 'exported data of',
        entityType: 'account',
        entityId: id,
        entityLabel: row.status === 'anonymized' ? `account ${id}` : row.name,
        before: { request: closed.length > 0 ? 'open' : 'none' },
        after: { request: 'exported', ...(guest ? { guestRow: guest.id } : {}) },
      });
      return { filename: exportFilename(id), bytes: Buffer.from(JSON.stringify(document, null, 2), 'utf8') };
    });
  }

  /**
   * Anonymizes an account, and the guest row of its proven email.
   *
   * @param staffId the signed-in staff member
   * @param id the account id (the retail rank)
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409, already anonymized), `CONFLICT` (409: a merchant rank; the guest row has an
   *   open checkout or a pending payment; or the store balance is not zero, a top-up waits for review, a top-up dispute is open, an order
   *   paid from the balance is still open or a refund to the balance waits for staff: feature 21, O12)
   */
  async anonymize(staffId: number, id: number): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      // The account row first, then the guest row (the lock order of an account, decision 064).
      const account = await this.directory.lockForUpdate(tx, id);
      if (!account) throw accountNotFound();
      if (account.status === 'anonymized') throw new AppError('ANONYMIZED');
      if (account.rankKind === 'merchant') throw new AppError('CONFLICT', { detail: MERCHANT_RANK_TEXT });
      const guest = coversGuestRow(account) ? await this.lockedGuestOf(tx, account) : undefined;
      // Refuse before any write: the same refusals as the account's own erasure, and the guest row's open checkout or payment.
      if (guest) {
        const open = await openObligationsOf(tx, guest.id, now);
        if (open.checkouts > 0 || open.payments > 0) throw new AppError('CONFLICT', { detail: guestRowOpenText(open) });
      }
      const row = await findCustomerById(tx, id);
      if (!row) throw accountNotFound();
      await this.erase(work, row, staffId, now, undefined);
      if (guest) {
        const guestRow = await findCustomerById(tx, guest.id);
        if (guestRow) await this.erase(work, guestRow, staffId, now, id);
      }
      work.afterCommit(() => this.lock.clear('shop', account.email));
    });
  }

  /**
   * The steps of one erasure: the row, the IMEIs, the checkout sessions, the erasure request, the hooks, the money, the access effects and
   * the audit row, in this order (the wallet rows are the last lock before the audit row, plan 21 5.7).
   *
   * @param work the anonymization's transaction
   * @param row the row to erase, as it was before
   * @param staffId the signed-in staff member (the handler of the erasure request)
   * @param now the clock's time
   * @param erasedWith the account whose erasure also erased this guest row; `undefined` for the account itself
   */
  private async erase(
    work: Work,
    row: AccountRow,
    staffId: number,
    now: Date,
    erasedWith: number | undefined,
  ): Promise<void> {
    const { tx } = work;
    const email = anonymizedEmail(row.id);
    await updateCustomerRow(tx, row.id, {
      status: 'anonymized',
      anonymizedAt: now,
      name: ANONYMIZED_NAME,
      email,
      emailVerifiedAt: null,
      phone: '',
      company: '',
      address: '',
      taxId: '',
      internalNotes: '',
      marketingOptIn: false,
      hasAccount: false,
      // The sign-in side goes with the person: the account closes and the row can no longer prove anything (clients_guest_check). The
      // Dhru username goes too: an account that once held a merchant rank keeps it after a rank change, and a guest row has none.
      username: null,
      passwordHash: null,
      passwordChangedAt: null,
      mustChangePassword: false,
      passwordSetByStaff: false,
      emailSetByStaff: false,
      totpSecretEnc: null,
      twofaEnabled: false,
      totpLastStep: null,
      totpFailures: 0,
      totpFailuresSince: null,
      totpLockedAt: null,
      lastLoginIp: null,
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
      updatedAt: now,
    });
    await eraseOrderImeis(tx, row.id, now);
    await eraseCheckoutSessions(tx, row.id, email, now);
    await this.requests.completePending(tx, row.id, 'erasure', staffId);
    await this.hooks.run(tx, row.id);
    // Last before the audit row: it locks the wallet rows, which must come after every other row (plan 21 § 5.7).
    await this.walletErasure.closeForErasure(tx, row.id);
    await this.effects.statusChanged(work, { accountId: row.id, to: 'anonymized' });
    await this.audit.record(tx, {
      action: 'anonymised account',
      entityType: 'account',
      entityId: row.id,
      // The old name is personal data and the audit log is append-only: the entry names the account by number.
      entityLabel: `account ${row.id}`,
      before: { status: row.status },
      after: {
        status: 'anonymized',
        name: ANONYMIZED_NAME,
        imei: 'removed (TAC kept)',
        ...(erasedWith === undefined ? {} : { erasedWith }),
      },
    });
  }

  /** The guest row of the account's email, or `undefined` when there is none (or the account is the guest row itself). */
  private async guestRowOf(db: DbExecutor, account: AccountRecord): Promise<AccountRecord | undefined> {
    const guest = await this.directory.findGuestByEmail(db, account.email);
    return guest && guest.id !== account.id ? guest : undefined;
  }

  /** Finds the guest row of the account's email and locks it (after the account row); a row that is already erased is left alone. */
  private async lockedGuestOf(tx: Work['tx'], account: AccountRecord): Promise<AccountRecord | undefined> {
    const found = await this.guestRowOf(tx, account);
    if (!found) return undefined;
    const locked = await this.directory.lockForUpdate(tx, found.id);
    return locked && !locked.hasAccount && locked.status !== 'anonymized' ? locked : undefined;
  }

  /** The digits of the IMEI stored on a checkout session, or `null` when it was erased or cannot be read. */
  private imeiOf(ciphertext: string | null): string | null {
    if (ciphertext === null) return null;
    try {
      return this.encryption.decrypt(ciphertext, CHECKOUT_IMEI_AAD);
    } catch {
      this.logger.error('A stored IMEI could not be decrypted for an account export.');
      return null;
    }
  }
}
