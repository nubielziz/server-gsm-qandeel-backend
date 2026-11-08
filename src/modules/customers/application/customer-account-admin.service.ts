// CustomerAccountAdminService: the use cases of POST /admin/customers/:id/account, /password, /sessions/revoke, /suspend and
// /reactivate (map domain I, stage 14, scenario b2c-account steps 6, 7 and 9). Block, export and anonymize are feature 18's.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService, type DbExecutor } from '../../../infra/db';
import {
  CUSTOMER_PASSWORD_LINK_PURPOSES,
  CustomerAuthTokens,
  type SessionWork,
  SessionService,
  type StaffPrincipal,
  temporaryPasswordFor,
} from '../../identity';
import { AuditService } from '../../platform';
import type { Customer } from '../db/schema';
import { type SuspendReason, suspendedReasonText } from '../domain/customer-status';
import { upsertCredentials } from '../infra/customer-credentials.repository';
import { CustomerSignInFailures } from '../infra/customer-sign-in-failures';
import { findCustomerById, updateCustomerRow } from '../infra/customer.repository';
import { activeSessionCount } from '../infra/foreign-reads.repository';
import { customerNotFound } from './customer-errors';
import { CustomerLinks } from './customer-links';

/** How a customer gets a password. */
export type PasswordMode = 'reset_link' | 'temporary_password';

/** What the password routes answer: the temporary password, shown once, in that mode only. */
export interface PasswordResult {
  readonly temporaryPassword?: string;
}

/**
 * Account actions of the customer page: create an account, set a password, sign out, suspend and reactivate.
 *
 * Why: scenario b2c-account. Every action locks the customer row, refuses an anonymized customer (`409 ANONYMIZED`), checks that
 * the state fits (`ACCOUNT_EXISTS`, `NO_ACCOUNT`, `NOT_ACTIVE`, `NOT_SUSPENDED`) and writes its audit row in the same
 * transaction; no password, hash or token ever enters the audit log. Suspending ends every session in the same transaction, so
 * the customer is signed out at once and keeps no way in; orders in progress are not touched, so they complete.
 *
 * Side effects: write `customers`, `customer_credentials`, `auth_tokens`, `outbox_events`, `sessions` and `audit_logs`.
 *
 * @see docs/contract/endpoints/customers.md
 */
@Injectable()
export class CustomerAccountAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly authTokens: CustomerAuthTokens,
    private readonly sessions: SessionService,
    private readonly links: CustomerLinks,
    private readonly failures: CustomerSignInFailures,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates an account for a guest.
   *
   * @param staff the signed-in staff member
   * @param id the customer id
   * @param mode how the customer gets a password
   * @param ip the request address, for the link record
   * @returns the temporary password in that mode, else nothing
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409), `ACCOUNT_EXISTS` (409)
   */
  async createAccount(staff: StaffPrincipal, id: number, mode: PasswordMode, ip: string): Promise<PasswordResult> {
    const customer = await this.assertExists(this.db.db, id);
    const temporary = this.temporaryFor(mode, customer);
    const passwordHash = temporary === undefined ? null : await this.hasher.hash(temporary);
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      const locked = await this.lock(work.tx, id);
      if (locked.hasAccount) throw new AppError('ACCOUNT_EXISTS');
      // The guest's earlier orders already carry customer_id: they are linked to the account as it is.
      await updateCustomerRow(work.tx, id, { hasAccount: true, updatedAt: now });
      await upsertCredentials(work.tx, id, {
        passwordHash,
        mustChangePassword: temporary !== undefined,
        passwordChangedAt: temporary === undefined ? null : now,
        updatedBy: staff.staffId,
        now,
      });
      if (temporary === undefined) {
        await this.links.send(work, { kind: 'invited', customerId: id, createdBy: staff.staffId, ip });
      }
      await this.audit.record(work.tx, {
        action: 'created account for',
        entityType: 'customer',
        entityId: id,
        entityLabel: locked.name,
        before: { account: 'guest' },
        after: {
          account: 'account',
          // Not `password`: the audit log redacts every key that ends in it, and this is only the way the password was set.
          credential: temporary === undefined ? 'invite link emailed' : 'temporary password set',
        },
      });
      // Wrong passwords tried for this email while it was a guest must not lock the new account.
      work.afterCommit(() => this.failures.clear(locked.email));
    });
    return temporary === undefined ? {} : { temporaryPassword: temporary };
  }

  /**
   * Sends a password link or sets a temporary password.
   *
   * @param staff the signed-in staff member
   * @param id the customer id
   * @param input the mode and whether to end the customer's sessions
   * @param ip the request address, for the link record
   * @returns the temporary password in that mode, else nothing
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409), `NO_ACCOUNT` (409)
   */
  async setPassword(
    staff: StaffPrincipal,
    id: number,
    input: { readonly mode: PasswordMode; readonly revokeSessions: boolean },
    ip: string,
  ): Promise<PasswordResult> {
    const customer = await this.assertExists(this.db.db, id);
    if (!customer.hasAccount) throw new AppError('NO_ACCOUNT');
    const temporary = this.temporaryFor(input.mode, customer);
    const passwordHash = temporary === undefined ? null : await this.hasher.hash(temporary);
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      const locked = await this.lock(work.tx, id);
      if (!locked.hasAccount) throw new AppError('NO_ACCOUNT');
      if (temporary === undefined) {
        // `send` voids the older invitation and reset links: only the newest works.
        await this.links.send(work, { kind: 'password_reset', customerId: id, createdBy: staff.staffId, ip });
      } else {
        await upsertCredentials(work.tx, id, {
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: now,
          updatedBy: staff.staffId,
          now,
        });
        // An older link must not undo the temporary password.
        await this.authTokens.voidOpen(work, id, CUSTOMER_PASSWORD_LINK_PURPOSES);
        // A customer who asked staff for help may be locked out: the new password opens the door again.
        work.afterCommit(() => this.failures.clear(locked.email));
      }
      const ended = input.revokeSessions ? await this.endSessions(work, id, now) : 0;
      await this.audit.record(work.tx, {
        action: temporary === undefined ? 'sent a password reset link to' : 'set a temporary password for',
        entityType: 'customer',
        entityId: id,
        entityLabel: locked.name,
        before: ended > 0 ? { sessions: ended } : null,
        after: {
          credential:
            temporary === undefined
              ? 'reset link emailed, valid for 1 hour'
              : 'temporary password set, change required at next sign-in',
          ...(ended > 0 ? { sessions: 0 } : {}),
        },
      });
    });
    return temporary === undefined ? {} : { temporaryPassword: temporary };
  }

  /**
   * Signs the customer out of every device.
   *
   * @param id the customer id
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409)
   */
  async revokeSessions(id: number): Promise<void> {
    await this.assertExists(this.db.db, id);
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      const customer = await this.lock(work.tx, id);
      const ended = await this.endSessions(work, id, now);
      await this.audit.record(work.tx, {
        action: 'signed out all devices of',
        entityType: 'customer',
        entityId: id,
        entityLabel: customer.name,
        before: { sessions: ended },
        after: { sessions: 0 },
      });
    });
  }

  /**
   * Suspends an active customer.
   *
   * @param staff the signed-in staff member
   * @param id the customer id
   * @param input a reason of the console's list and an optional note
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409), `NOT_ACTIVE` (409)
   */
  async suspend(
    staff: StaffPrincipal,
    id: number,
    input: { readonly reason: SuspendReason; readonly note?: string | undefined },
  ): Promise<void> {
    await this.assertExists(this.db.db, id);
    const now = this.clock.now();
    const text = suspendedReasonText(input.reason, input.note);
    await this.db.runInTransaction(async (work) => {
      const customer = await this.lock(work.tx, id);
      if (customer.status !== 'active') throw new AppError('NOT_ACTIVE');
      await updateCustomerRow(work.tx, id, {
        status: 'suspended',
        suspendedAt: now,
        suspendedBy: staff.staffId,
        suspendedReason: text,
        updatedAt: now,
      });
      // Nothing is added to the blocklist: a suspension is a pause, not fraud (scenario b2c-account step 7).
      const ended = await this.endSessions(work, id, now);
      await this.audit.record(work.tx, {
        action: 'suspended account of',
        entityType: 'customer',
        entityId: id,
        entityLabel: customer.name,
        before: { status: 'active', ...(ended > 0 ? { sessions: ended } : {}) },
        after: { status: 'suspended', reason: text, ...(ended > 0 ? { sessions: 0 } : {}) },
      });
    });
  }

  /**
   * Reactivates a suspended customer.
   *
   * @param id the customer id
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409), `NOT_SUSPENDED` (409)
   */
  async reactivate(id: number): Promise<void> {
    await this.assertExists(this.db.db, id);
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      const customer = await this.lock(work.tx, id);
      if (customer.status !== 'suspended') throw new AppError('NOT_SUSPENDED');
      await updateCustomerRow(work.tx, id, {
        status: 'active',
        suspendedAt: null,
        suspendedBy: null,
        suspendedReason: null,
        updatedAt: now,
      });
      await this.audit.record(work.tx, {
        action: 'reactivated account of',
        entityType: 'customer',
        entityId: id,
        entityLabel: customer.name,
        before: { status: 'suspended' },
        after: { status: 'active' },
      });
    });
  }

  /** Counts the live sessions, then ends them in the caller's transaction; returns how many there were. */
  private async endSessions(work: SessionWork, id: number, now: Date): Promise<number> {
    const live = await activeSessionCount(work.tx, id, now);
    await this.sessions.revokeAllOf('customer', id, {}, work);
    return live;
  }

  private temporaryFor(mode: PasswordMode, customer: Customer): string | undefined {
    return mode === 'temporary_password'
      ? temporaryPasswordFor((max) => randomInt(max), { email: customer.email, name: customer.name })
      : undefined;
  }

  /** Reads the customer outside the transaction to refuse a missing or anonymized one before any hashing. */
  private async assertExists(db: DbExecutor, id: number): Promise<Customer> {
    const customer = await findCustomerById(db, id);
    if (!customer) throw customerNotFound();
    if (customer.status === 'anonymized') throw new AppError('ANONYMIZED');
    return customer;
  }

  /** Locks the customer for the rest of the transaction and re-checks that it exists and is not anonymized. */
  private async lock(db: DbExecutor, id: number): Promise<Customer> {
    return this.assertLocked(await findCustomerById(db, id, true));
  }

  private assertLocked(customer: Customer | undefined): Customer {
    if (!customer) throw customerNotFound();
    if (customer.status === 'anonymized') throw new AppError('ANONYMIZED');
    return customer;
  }
}
