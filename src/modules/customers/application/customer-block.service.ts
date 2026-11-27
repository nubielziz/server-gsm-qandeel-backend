// CustomerBlockService: POST /admin/clients/:id/block (map domain I, stage 18, RESOLUTIONS b2c-5, B48; decision 064): block an account of any
// rank for fraud and add what identifies it to the blocklist, or lift the block and remove only what that block added.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { EncryptionService } from '../../../infra/crypto';
import { DbService, type DbExecutor, type TransactionContext } from '../../../infra/db';
import { AccountAccessEffects } from '../../identity';
import { type SellableField, StorefrontServices } from '../../catalog';
import { fieldImeisOf } from '../../orders';
import { AuditService } from '../../platform';
import { Blocklist, type BlockRequest } from '../../risk';
import { CHECKOUT_IMEI_AAD } from '../domain/checkout';
import {
  BLOCK_REASONS,
  MAX_BLOCK_NOTE_LENGTH,
  appendNote,
  blockNoteLine,
  statusAfterUnblock,
} from '../domain/customer-privacy';
import { type AccountRow, findCustomerById, updateCustomerRow } from '../infra/customer.repository';
import { cardFingerprintsOf, storedImeisOf } from '../infra/privacy-reads.repository';
import { accountNotFound } from './customer-errors';

/** What `POST /admin/clients/:id/block` carries. */
export interface BlockInput {
  /** True to block, false to lift the block. */
  readonly blocked: boolean;
  /** One of the console's four reasons when blocking (`422` on `reason` otherwise); free text, optional, when lifting. */
  readonly reason?: string | undefined;
}

/** The transaction a use case works in. */
type Work = Pick<TransactionContext, 'tx' | 'afterCommit'>;

/**
 * Blocks and unblocks accounts.
 *
 * Why: scenario b2c-account and b2c-chargeback, decision 064 (any rank). A block is for fraud (a pause is a suspension): the
 * account becomes `blocked`, every session ends and every live API key stops (`AccountAccessEffects.statusChanged`), and the blocklist
 * gets, with source manual, the reason, the caller and `account_id` set: the account's email always, each distinct card fingerprint of its
 * payments and each distinct IMEI still stored on its **shop** orders and checkout sessions (a device is its IMEI, B77; the main input and,
 * decision 073, the values of fields of type `imei` and, decision 076, each line of the fields of type `imei_bulk` and of a main input,
 * read through the catalog's `StorefrontServices.fields`). A merchant orders
 * through the portal and Dhru for other people's devices, so the IMEIs of those orders are never added. Each insert is
 * `ON CONFLICT DO NOTHING`, so an entry that already exists (a risk refund, a chargeback, a manual add, another account's block) is kept
 * unchanged and not linked. The reason is appended to the internal notes (B48). A suspension the account had is kept under the block
 * (decision 046: only `clients:security` lifts a suspension), so lifting moves `blocked` back to `suspended` when one is recorded and to
 * `active` otherwise, and deletes only the entries `WHERE account_id = :id AND source = 'manual'`. Both are one transaction with their
 * audit row (`blocked account`, `unblocked account`); the account row is locked first, so two blocks at once make one block.
 *
 * Side effects: updates `clients`; inserts or deletes `blocklist_entries`; ends `sessions` and revokes `api_keys` (through the access
 * effects); inserts `audit_logs`.
 */
@Injectable()
export class CustomerBlockService {
  constructor(
    private readonly db: DbService,
    private readonly blocklist: Blocklist,
    private readonly effects: AccountAccessEffects,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly services: StorefrontServices,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Blocks or unblocks an account.
   *
   * @param staffId the signed-in staff member
   * @param id the account id (any rank)
   * @param input the switch and the reason
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409), `ALREADY_BLOCKED` (409), `NOT_BLOCKED` (409), `VALIDATION_FAILED`
   *   (422, on `reason`)
   */
  async setBlocked(staffId: number, id: number, input: BlockInput): Promise<void> {
    const reason = input.reason?.trim() ?? '';
    if (input.blocked) this.assertReason(reason);
    if (reason.length > MAX_BLOCK_NOTE_LENGTH) {
      throw reasonProblem(`Use at most ${MAX_BLOCK_NOTE_LENGTH} characters.`);
    }
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      // The account row is the first lock of every path of an account (decision 064).
      const account = await findCustomerById(work.tx, id, true);
      if (!account) throw accountNotFound();
      if (account.status === 'anonymized') throw new AppError('ANONYMIZED');
      if (input.blocked) await this.block(work, account, staffId, reason, now);
      else await this.unblock(work, account, reason, now);
    });
  }

  private async block(work: Work, account: AccountRow, staffId: number, reason: string, now: Date): Promise<void> {
    if (account.status === 'blocked') throw new AppError('ALREADY_BLOCKED');
    const { tx } = work;
    const requests = await this.requestsFor(tx, account, staffId, reason);
    const added = await this.blocklist.add(tx, requests);
    await updateCustomerRow(tx, account.id, {
      status: 'blocked',
      // A suspension stays recorded under the block (its columns are kept): lifting the block must not lift it (decision 046).
      internalNotes: appendNote(account.internalNotes, blockNoteLine(reason)),
      updatedAt: now,
    });
    await this.effects.statusChanged(work, { accountId: account.id, to: 'blocked' });
    await this.audit.record(tx, {
      action: 'blocked account',
      entityType: 'account',
      entityId: account.id,
      entityLabel: account.name,
      before: { status: account.status },
      after: { status: 'blocked', reason, blocklisted: added.length },
    });
  }

  private async unblock(work: Work, account: AccountRow, reason: string, now: Date): Promise<void> {
    if (account.status !== 'blocked') throw new AppError('NOT_BLOCKED');
    const { tx } = work;
    const removed = await this.blocklist.removeAddedByBlockOf(tx, account.id);
    // Decision 046: only a holder of `clients:security` lifts a suspension, through the status change. An account that was suspended when
    // it was blocked goes back to that suspension, with its reason, time and author as they were.
    const to = statusAfterUnblock(account);
    await updateCustomerRow(tx, account.id, { status: to, updatedAt: now });
    await this.effects.statusChanged(work, { accountId: account.id, to });
    await this.audit.record(tx, {
      action: 'unblocked account',
      entityType: 'account',
      entityId: account.id,
      entityLabel: account.name,
      before: { status: 'blocked' },
      after: { status: to, ...(reason === '' ? {} : { reason }), removed: removed.length },
    });
  }

  /** The values that identify the account: the email, the cards and the IMEIs of its shop orders still stored. */
  private async requestsFor(
    tx: DbExecutor,
    account: AccountRow,
    staffId: number,
    reason: string,
  ): Promise<BlockRequest[]> {
    // `accountId` names the account a block came from, so an unblock lifts exactly the entries of this account.
    const base = { reason, source: 'manual', createdBy: staffId, accountId: account.id } as const;
    const requests: BlockRequest[] = [{ ...base, kind: 'email', value: account.email }];
    for (const fingerprint of await cardFingerprintsOf(tx, account.id)) {
      requests.push({ ...base, kind: 'card', value: fingerprint });
    }
    for (const imei of await this.imeisOf(tx, account.id)) requests.push({ ...base, kind: 'imei', value: imei });
    return requests;
  }

  /**
   * Every distinct 15-digit IMEI on the account's shop orders and checkout sessions that is still stored: their main inputs (each line of
   * one, decision 076: the main input of an `imei_bulk` field is its list, one IMEI per line) and, decision 073, the values of their fields
   * of type `imei` and, decision 076, each line of their fields of type `imei_bulk` (the service's fields as the catalog lists them now;
   * `fieldImeisOf` says which values hold IMEIs).
   */
  private async imeisOf(tx: DbExecutor, accountId: number): Promise<string[]> {
    const stored = await storedImeisOf(tx, accountId);
    const found = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value !== 'string') return;
      const digits = value.replace(/[\s-]/g, '');
      if (/^\d{15}$/.test(digits)) found.add(digits);
    };
    // A main input is one value, or the list of an `imei_bulk` field joined with line breaks: it is read whole, as before, and line by line.
    const addLines = (value: string) => {
      add(value);
      if (/[\r\n]/.test(value)) value.split(/[\r\n]/).forEach(add);
    };
    for (const input of stored.orderInputs) addLines(input);
    const fieldsOf = new Map<number, SellableField[]>();
    for (const { serviceId, inputs } of stored.fieldValues) {
      let fields = fieldsOf.get(serviceId);
      if (fields === undefined) {
        // One query at a time: the transaction is one connection.
        fields = await this.services.fields(tx, serviceId);
        fieldsOf.set(serviceId, fields);
      }
      for (const field of fields) {
        const value = inputs[field.key];
        if (typeof value === 'string') fieldImeisOf(field, value).forEach(add);
      }
    }
    for (const text of stored.sessionCiphertexts) {
      try {
        addLines(this.encryption.decrypt(text, CHECKOUT_IMEI_AAD));
      } catch {
        // An unreadable ciphertext cannot be blocked; the order's own IMEI (if any) still is.
      }
    }
    return [...found].sort();
  }

  private assertReason(reason: string): void {
    if (!(BLOCK_REASONS as readonly string[]).includes(reason)) throw reasonProblem('Choose a reason.');
  }
}

function reasonProblem(message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field: 'reason', code: 'invalid_reason', message }] });
}
