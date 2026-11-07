// The accounts behind sessions (identity module): what state is a staff member, a merchant or a customer in? A session is only
// as good as its account, so the guards ask this directory when they load a session. Customers belong to the customers
// module; it registers its resolver here when its feature is built, until then customer sessions are refused.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../../../infra/db';
import { type SubjectType, clients, staffUsers } from '../db/schema';
import type { SubjectSnapshot } from './session.types';

/**
 * Reads the state of the accounts of one subject type.
 *
 * Why: the identity module owns staff and merchants but not storefront customers (module ownership,
 * `scripts/module-map.mjs`), so each subject type brings its own reader and maps its own statuses onto `ok`, `suspended` and
 * `gone` (decision 018: "the same mechanics with their tables and statuses").
 */
export interface SessionSubjectResolver {
  readonly subjectType: SubjectType;
  /**
   * Reads the account.
   *
   * @param subjectId the account id from the session
   * @returns `suspended` when the account must be refused with `403 ACCOUNT_SUSPENDED`, `gone` when it no longer exists or
   *   must be treated as ended (`401`), otherwise `ok` (staff add their role id)
   */
  resolve(subjectId: number): Promise<SubjectSnapshot>;
}

/** Staff: `suspended` stops everything; `invited` may sign in (that is how the first sign-in works). */
class StaffSubjectResolver implements SessionSubjectResolver {
  readonly subjectType = 'staff';

  constructor(private readonly db: DbService) {}

  async resolve(subjectId: number): Promise<SubjectSnapshot> {
    const [row] = await this.db.db
      .select({ status: staffUsers.status, roleId: staffUsers.roleId, name: staffUsers.name })
      .from(staffUsers)
      .where(eq(staffUsers.id, subjectId))
      .limit(1);
    if (!row) return { state: 'gone' };
    return { state: row.status === 'suspended' ? 'suspended' : 'ok', roleId: row.roleId, name: row.name };
  }
}

/**
 * Merchants: `suspended` stops everything; `pending` merchants may sign in and manage their own account, and the access
 * handler refuses every other merchant route for them with `403 ACCOUNT_PENDING_APPROVAL` (B153).
 */
class ClientSubjectResolver implements SessionSubjectResolver {
  readonly subjectType = 'client';

  constructor(private readonly db: DbService) {}

  async resolve(subjectId: number): Promise<SubjectSnapshot> {
    const [row] = await this.db.db
      .select({ status: clients.status, name: clients.name })
      .from(clients)
      .where(eq(clients.id, subjectId))
      .limit(1);
    if (!row) return { state: 'gone' };
    return {
      state: row.status === 'suspended' ? 'suspended' : 'ok',
      name: row.name,
      approved: row.status === 'active',
    };
  }
}

/**
 * The directory of subject resolvers.
 *
 * Why: see {@link SessionSubjectResolver}. Staff and merchants are built in; the customers module registers its resolver in
 * `onModuleInit` (feature 14b). A subject type without a resolver has no valid sessions, which fails closed.
 */
@Injectable()
export class SessionSubjects {
  private readonly resolvers = new Map<SubjectType, SessionSubjectResolver>();

  constructor(db: DbService) {
    this.register(new StaffSubjectResolver(db));
    this.register(new ClientSubjectResolver(db));
  }

  /**
   * Adds the resolver of a subject type.
   *
   * @param resolver the resolver
   * @throws {Error} when the subject type already has one (a boot-time programming error)
   */
  register(resolver: SessionSubjectResolver): void {
    if (this.resolvers.has(resolver.subjectType)) {
      throw new Error(`A session subject resolver for "${resolver.subjectType}" is already registered`);
    }
    this.resolvers.set(resolver.subjectType, resolver);
  }

  /**
   * Reads an account's state.
   *
   * @param subjectType staff, client or customer
   * @param subjectId the account id
   * @returns the snapshot; `gone` when the subject type has no resolver
   */
  resolve(subjectType: SubjectType, subjectId: number): Promise<SubjectSnapshot> {
    const resolver = this.resolvers.get(subjectType);
    return resolver ? resolver.resolve(subjectId) : Promise.resolve({ state: 'gone' });
  }

  /**
   * Tells whether a subject type can have valid sessions.
   *
   * @param subjectType staff, client or customer
   * @returns true when a resolver is registered
   */
  has(subjectType: SubjectType): boolean {
    return this.resolvers.has(subjectType);
  }
}
