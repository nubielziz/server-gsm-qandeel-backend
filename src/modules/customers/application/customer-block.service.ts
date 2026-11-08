// CustomerBlockService: POST /admin/customers/:id/block (map domain I, stage 18, RESOLUTIONS b2c-5, B48): block a customer for fraud
// and add what identifies them to the blocklist, or lift the block and remove only what that block added.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { EncryptionService } from '../../../infra/crypto';
import { DbService, type DbExecutor } from '../../../infra/db';
import { type SessionWork, SessionService } from '../../identity';
import { AuditService } from '../../platform';
import { Blocklist, type BlockRequest } from '../../risk';
import type { Customer } from '../db/schema';
import { CHECKOUT_IMEI_AAD } from '../domain/checkout';
import { BLOCK_REASONS, MAX_BLOCK_NOTE_LENGTH, appendNote, blockNoteLine } from '../domain/customer-privacy';
import { findCustomerById, updateCustomerRow } from '../infra/customer.repository';
import { cardFingerprintsOf, storedImeisOf } from '../infra/privacy-reads.repository';
import { customerNotFound } from './customer-errors';

/** What `POST /admin/customers/:id/block` carries. */
export interface BlockInput {
  /** True to block, false to lift the block. */
  readonly blocked: boolean;
  /** One of the console's four reasons when blocking (`422` on `reason` otherwise); free text, optional, when lifting. */
  readonly reason?: string | undefined;
}

/**
 * Blocks and unblocks customers.
 *
 * Why: scenario b2c-account and b2c-chargeback. A block is for fraud (a pause is `suspend`): the customer becomes `blocked` with
 * `risk_level` high, every session ends, and the blocklist gets, with source manual, the reason, the caller and `customer_id` set:
 * the customer's email, each distinct card fingerprint of their payments and each distinct IMEI still stored on their orders and
 * checkout sessions (a device is its IMEI, B77). Each insert is `ON CONFLICT DO NOTHING`, so an entry that already exists (a risk
 * refund, a chargeback, a manual add, another customer's block) is kept unchanged and not linked. The reason is appended to the
 * internal notes (B48). Lifting moves `blocked` to `active`, `high` risk to `medium`, and deletes only the entries
 * `WHERE customer_id = :id AND source = 'manual'`. Both are one transaction with their audit row (`blocked customer`, `unblocked
 * customer`).
 *
 * Side effects: updates `customers`; inserts or deletes `blocklist_entries`; revokes `sessions`; inserts `audit_logs`.
 */
@Injectable()
export class CustomerBlockService {
  constructor(
    private readonly db: DbService,
    private readonly blocklist: Blocklist,
    private readonly sessions: SessionService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Blocks or unblocks a customer.
   *
   * @param staffId the signed-in staff member
   * @param id the customer id
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
      const customer = await findCustomerById(work.tx, id, true);
      if (!customer) throw customerNotFound();
      if (customer.status === 'anonymized') throw new AppError('ANONYMIZED');
      if (input.blocked) await this.block(work, customer, staffId, reason, now);
      else await this.unblock(work, customer, reason, now);
    });
  }

  private async block(
    work: SessionWork,
    customer: Customer,
    staffId: number,
    reason: string,
    now: Date,
  ): Promise<void> {
    if (customer.status === 'blocked') throw new AppError('ALREADY_BLOCKED');
    const { tx } = work;
    const requests = await this.requestsFor(tx, customer, staffId, reason);
    const added = await this.blocklist.add(tx, requests);
    await updateCustomerRow(tx, customer.id, {
      status: 'blocked',
      riskLevel: 'high',
      // A suspension ends here: the customer is blocked now, and a later unblock must not show a stale suspension.
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
      internalNotes: appendNote(customer.internalNotes, blockNoteLine(reason)),
      updatedAt: now,
    });
    await this.sessions.revokeAllOf('customer', customer.id, {}, work);
    await this.audit.record(tx, {
      action: 'blocked customer',
      entityType: 'customer',
      entityId: customer.id,
      entityLabel: customer.name,
      before: { status: customer.status },
      after: { status: 'blocked', reason, blocklisted: added.length },
    });
  }

  private async unblock(work: SessionWork, customer: Customer, reason: string, now: Date): Promise<void> {
    if (customer.status !== 'blocked') throw new AppError('NOT_BLOCKED');
    const { tx } = work;
    const removed = await this.blocklist.removeAddedByBlockOf(tx, customer.id);
    await updateCustomerRow(tx, customer.id, {
      status: 'active',
      riskLevel: customer.riskLevel === 'high' ? 'medium' : customer.riskLevel,
      updatedAt: now,
    });
    await this.audit.record(tx, {
      action: 'unblocked customer',
      entityType: 'customer',
      entityId: customer.id,
      entityLabel: customer.name,
      before: { status: 'blocked' },
      after: { status: 'active', ...(reason === '' ? {} : { reason }), removed: removed.length },
    });
  }

  /** The values that identify the customer: the email, the cards and the IMEIs still stored. */
  private async requestsFor(
    tx: DbExecutor,
    customer: Customer,
    staffId: number,
    reason: string,
  ): Promise<BlockRequest[]> {
    const base = { reason, source: 'manual', createdBy: staffId, customerId: customer.id } as const;
    const requests: BlockRequest[] = [{ ...base, kind: 'email', value: customer.email }];
    for (const fingerprint of await cardFingerprintsOf(tx, customer.id)) {
      requests.push({ ...base, kind: 'card', value: fingerprint });
    }
    for (const imei of await this.imeisOf(tx, customer.id)) requests.push({ ...base, kind: 'imei', value: imei });
    return requests;
  }

  /** Every distinct 15-digit IMEI on the customer's orders and checkout sessions that is still stored. */
  private async imeisOf(tx: DbExecutor, customerId: number): Promise<string[]> {
    const stored = await storedImeisOf(tx, customerId);
    const found = new Set<string>();
    for (const input of stored.orderInputs) {
      const digits = input.replace(/[\s-]/g, '');
      if (/^\d{15}$/.test(digits)) found.add(digits);
    }
    for (const text of stored.sessionCiphertexts) {
      try {
        const digits = this.encryption.decrypt(text, CHECKOUT_IMEI_AAD).replace(/[\s-]/g, '');
        if (/^\d{15}$/.test(digits)) found.add(digits);
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
