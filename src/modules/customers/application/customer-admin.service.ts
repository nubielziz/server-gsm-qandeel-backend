// CustomerAdminService: the use cases of GET and POST /admin/customers and GET and PATCH /admin/customers/:id (map domain I,
// stage 14, scenario b2c-account steps 1 and 2): list, detail, create an account, edit.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService, type DbExecutor, isUniqueViolation } from '../../../infra/db';
import {
  CUSTOMER_TOKEN_PURPOSES,
  CustomerAuthTokens,
  SignInLock,
  type StaffPrincipal,
  temporaryPasswordFor,
} from '../../identity';
import { AuditService } from '../../platform';
import { Blocklist } from '../../risk';
import type { Customer } from '../db/schema';
import { profileChanges } from '../domain/profile-edit';
import { findCredentials, upsertCredentials } from '../infra/customer-credentials.repository';
import {
  type CustomerSortField,
  findCustomerByEmail,
  findCustomerById,
  findCustomerRow,
  insertCustomer,
  listCustomerRows,
  updateCustomerRow,
} from '../infra/customer.repository';
import {
  activeSessionCount,
  detailCounts,
  lastSeenIp,
  latestConsentEvidence,
  riskOf,
} from '../infra/foreign-reads.repository';
import { customerNotFound, emailBlocked } from './customer-errors';
import { CustomerLinks } from './customer-links';
import { CustomerProfileRules } from './customer-profile-rules';
import { type WireCustomer, type WireCustomerDetail, toWireCustomer, toWireDetail } from './customer-views';

/** The fields of a new customer, as the request carries them (cleaned by the contract). */
export interface CreateCustomerInput {
  readonly name: string;
  readonly email: string;
  readonly country: string;
  readonly phone?: string | undefined;
  readonly mode: 'reset_link' | 'temporary_password';
}

/** The fields an edit may carry. */
export interface UpdateCustomerInput {
  readonly name?: string | undefined;
  readonly email?: string | undefined;
  readonly country?: string | undefined;
  readonly phone?: string | undefined;
  readonly internalNotes?: string | undefined;
}

/** What `create` answers: the customer, and the temporary password (shown once) in that mode. */
export interface CreatedCustomer {
  readonly customer: WireCustomer;
  readonly temporaryPassword?: string;
}

const EMAIL_UNIQUE_INDEX = 'customers_email_uq';

/**
 * Lists, reads, creates and edits storefront customers for staff.
 *
 * Why: scenario b2c-account: staff create a customer with an account (invitation link or temporary password), edit the
 * details and read the whole picture. The unique email index is the last word on `EMAIL_TAKEN`; a blocklisted email is `422`
 * on `email` (B46, b2c-16); an anonymized customer cannot be edited; a changed email clears the verification and, for an
 * account, sends a new verification link (b2c-16). Every write is audited with the demo's verb phrase and never records a
 * password.
 *
 * Side effects: `create` and `update` write `customers`, `customer_credentials`, `auth_tokens`, `outbox_events` and
 * `audit_logs`.
 *
 * @see docs/contract/endpoints/customers.md
 */
@Injectable()
export class CustomerAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly blocklist: Blocklist,
    private readonly authTokens: CustomerAuthTokens,
    private readonly links: CustomerLinks,
    private readonly lock: SignInLock,
    private readonly rules: CustomerProfileRules,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists customers.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<CustomerSortField>): Promise<{ rows: WireCustomer[]; total: number }> {
    const { rows, total } = await listCustomerRows(this.db.db, query);
    return { rows: rows.map(toWireCustomer), total };
  }

  /**
   * Reads one customer with the detail figures.
   *
   * @param id the customer id
   * @returns the detail
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async get(id: number): Promise<WireCustomerDetail> {
    const db = this.db.db;
    const row = await findCustomerRow(db, id);
    if (!row) throw customerNotFound();
    const now = this.clock.now();
    const [counts, risk, consents, account] = await Promise.all([
      detailCounts(db, id),
      riskOf(db, id),
      latestConsentEvidence(db, id),
      row.customer.hasAccount ? this.accountSide(db, id, now) : Promise.resolve(null),
    ]);
    return toWireDetail(row, { counts, risk, consents, account });
  }

  /**
   * Creates a customer with an account.
   *
   * @param staff the signed-in staff member
   * @param input the cleaned fields and how the customer gets a password
   * @param ip the request address, for the link record
   * @returns the new customer and, for the temporary mode, the password (shown once)
   * @throws {AppError} `EMAIL_TAKEN` (409), `VALIDATION_FAILED` (422 on `email`: blocklisted; on `country`: the storefront does not sell there)
   */
  async create(staff: StaffPrincipal, input: CreateCustomerInput, ip: string): Promise<CreatedCustomer> {
    const now = this.clock.now();
    await this.assertEmailFree(this.db.db, input.email);
    if (await this.blocklist.isEmailBlocked(this.db.db, input.email)) throw emailBlocked();
    await this.rules.assertCountryAccepted(this.db.db, input.country, now);
    const temporary =
      input.mode === 'temporary_password'
        ? temporaryPasswordFor((max) => randomInt(max), { email: input.email, name: input.name })
        : undefined;
    // argon2 takes tens of milliseconds: hash before the transaction.
    const passwordHash = temporary === undefined ? null : await this.hasher.hash(temporary);
    const currency = await this.rules.currencyFor(this.db.db, input.country);

    const id = await this.db
      .runInTransaction(async (work) => {
        await this.assertEmailFree(work.tx, input.email);
        const customer = await insertCustomer(work.tx, {
          email: input.email,
          name: input.name,
          phone: input.phone ?? '',
          country: input.country,
          currency,
          hasAccount: true,
          createdBy: staff.staffId,
          createdAt: now,
          updatedAt: now,
        });
        await upsertCredentials(work.tx, customer.id, {
          passwordHash,
          mustChangePassword: temporary !== undefined,
          passwordChangedAt: temporary === undefined ? null : now,
          updatedBy: staff.staffId,
          now,
        });
        if (temporary === undefined) {
          await this.links.send(work, { kind: 'invited', customerId: customer.id, createdBy: staff.staffId, ip });
        }
        await this.audit.record(work.tx, {
          action: 'created customer',
          entityType: 'customer',
          entityId: customer.id,
          entityLabel: customer.name,
          after: {
            email: customer.email,
            country: customer.country,
            created_by: 'staff',
            // Not `password`: the audit log redacts every key that ends in it, and this is only the way the password was set.
            credential: temporary === undefined ? 'invite link emailed' : 'temporary password set',
          },
        });
        return customer.id;
      })
      .catch((error: unknown) => {
        // Two requests with the same email at once: the unique index decides.
        if (isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) throw new AppError('EMAIL_TAKEN');
        throw error;
      });
    // Failed passwords tried for this email before the account existed must not lock the new account.
    await this.lock.clear('shop', input.email);
    const row = (await findCustomerRow(this.db.db, id))!;
    return { customer: toWireCustomer(row), ...(temporary === undefined ? {} : { temporaryPassword: temporary }) };
  }

  /**
   * Edits a customer.
   *
   * @param staff the signed-in staff member
   * @param id the customer id
   * @param input the fields to change
   * @param ip the request address, for the verification link record
   * @returns the customer after the edit
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409), `EMAIL_TAKEN` (409), `VALIDATION_FAILED` (422 on `email`:
   *   blocklisted; on `country`: a new country the storefront does not sell to)
   */
  async update(staff: StaffPrincipal, id: number, input: UpdateCustomerInput, ip: string): Promise<WireCustomer> {
    const now = this.clock.now();
    const current = await findCustomerById(this.db.db, id);
    if (!current) throw customerNotFound();
    if (current.status === 'anonymized') throw new AppError('ANONYMIZED');
    const currency = input.country !== undefined ? await this.rules.currencyFor(this.db.db, input.country) : undefined;

    await this.db
      .runInTransaction(async (work) => {
        const customer = await findCustomerById(work.tx, id, true);
        if (!customer) throw customerNotFound();
        if (customer.status === 'anonymized') throw new AppError('ANONYMIZED');
        // "A new email" is judged against the locked row, like the country: another edit may have changed the address since the first
        // read, so an address that looked unchanged can be a change now (and an address that looked new can be the stored one again).
        const newEmail =
          input.email !== undefined && input.email !== customer.email.toLowerCase() ? input.email : undefined;
        if (newEmail !== undefined) {
          // The blocklist (risk) only matters for a new email, so it is asked here, once the new email is known.
          if (await this.blocklist.isEmailBlocked(work.tx, newEmail)) throw emailBlocked();
          await this.assertEmailFree(work.tx, newEmail, id);
        }
        // Only a country change is checked: a form that sends the stored country again must not fail when its tax rate has ended
        // since. "Changed" is judged against the locked row: another edit may have landed since the first read.
        if (input.country !== undefined && input.country !== customer.country) {
          await this.rules.assertCountryAccepted(work.tx, input.country, now);
        }

        const changes = changesOf(customer, input, newEmail, currency);
        const written = Object.keys(changes.columns).length > 0;
        if (written) await updateCustomerRow(work.tx, id, { ...changes.columns, updatedAt: now });
        if (newEmail !== undefined) {
          // Every link sent to the old address dies with it, guests' too: using one would mark the new address as proven (b2c-16).
          await this.authTokens.voidOpen(work, id, CUSTOMER_TOKEN_PURPOSES);
          // A new address has to be confirmed again; guests have nobody to send a link to.
          if (customer.hasAccount) {
            await this.links.send(work, { kind: 'email_verification', customerId: id, createdBy: staff.staffId, ip });
          }
        }
        await this.audit.record(work.tx, {
          action: 'edited details of',
          entityType: 'customer',
          entityId: id,
          entityLabel: customer.name,
          before: changes.before,
          after: changes.after,
        });
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) throw new AppError('EMAIL_TAKEN');
        throw error;
      });
    return toWireCustomer((await findCustomerRow(this.db.db, id))!);
  }

  /** The sign-in side of an account for the detail. */
  private async accountSide(db: DbExecutor, id: number, now: Date) {
    const [credentials, resetSentAt, activeSessions, lastIp] = await Promise.all([
      findCredentials(db, id),
      this.authTokens.passwordLinkSentAt(id, db),
      activeSessionCount(db, id, now),
      lastSeenIp(db, id),
    ]);
    return {
      mustChangePassword: credentials?.mustChangePassword ?? false,
      passwordChangedAt: credentials?.passwordChangedAt ?? null,
      resetSentAt,
      activeSessions,
      lastIp,
    };
  }

  /**
   * Refuses an email another customer already uses.
   *
   * @throws {AppError} `EMAIL_TAKEN` (409) whose detail names the owner (customers.md POST)
   */
  private async assertEmailFree(db: DbExecutor, email: string, exceptId?: number): Promise<void> {
    const owner = await findCustomerByEmail(db, email, exceptId);
    if (!owner) return;
    const who = owner.name === '' ? 'another customer' : owner.name;
    throw new AppError('EMAIL_TAKEN', {
      detail: `${email} already belongs to ${who}${owner.hasAccount ? '.' : ', who bought as a guest. Open them and use “Create account” instead.'}`,
    });
  }
}

/** What an edit changes: the columns to write and the old and new values of the audit entry. */
interface Changes {
  readonly columns: Partial<Customer>;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

/**
 * Works out which fields of an edit really change.
 *
 * Why: the audit entry records the old and new value of each changed field only, and a field sent with the stored value is not a
 * change. Name, country (with the derived currency) and phone are judged by the rule the customer's own edit shares
 * (`profileChanges`); a new email clears the verification.
 */
function changesOf(
  customer: Customer,
  input: UpdateCustomerInput,
  newEmail: string | undefined,
  currency: string | null | undefined,
): Changes {
  const { columns, before, after } = profileChanges(customer, input, currency);
  const note = (field: string, from: unknown, to: unknown) => {
    before[field] = from;
    after[field] = to;
  };
  if (newEmail !== undefined) {
    columns.email = newEmail;
    columns.emailVerifiedAt = null;
    note('email', customer.email, newEmail);
    if (customer.hasAccount && customer.emailVerifiedAt !== null) note('email_verified', true, false);
  }
  if (input.internalNotes !== undefined && input.internalNotes !== customer.internalNotes) {
    columns.internalNotes = input.internalNotes;
    note('notes', customer.internalNotes, input.internalNotes);
  }
  return { columns, before, after };
}
