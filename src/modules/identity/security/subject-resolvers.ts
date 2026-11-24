// The accounts behind sessions (identity module): what state is a staff member or an account in? A session is only as good as its
// account, so the guards ask this directory when they load a session.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../../../infra/db';
import { sessionStateOf } from '../accounts/account-status';
import { type SubjectType, clients, staffUsers } from '../db/schema';
import { RankKinds } from './rank-kinds';
import type { SubjectSnapshot } from './session.types';

/**
 * Reads the state of the accounts of one subject type.
 *
 * Why: each subject type brings its own reader and maps its own statuses onto `ok`, `suspended` and `gone` (decision 018: "the same
 * mechanics with their tables and statuses").
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
 * Accounts (decision 064): no row, a guest row (an email that ordered without signing up) or an anonymized account is `gone` (401);
 * a suspended or blocked account is `suspended` (403, and the authenticator revokes its sessions); an active account is `ok` with its
 * rank. A rank whose kind cannot be read (no lookup installed, or no such rank) is `gone`: the session fails closed.
 */
class AccountSubjectResolver implements SessionSubjectResolver {
  readonly subjectType = 'account';

  constructor(
    private readonly db: DbService,
    private readonly ranks: RankKinds,
  ) {}

  async resolve(subjectId: number): Promise<SubjectSnapshot> {
    const [row] = await this.db.db
      .select({ status: clients.status, name: clients.name, groupId: clients.groupId, hasAccount: clients.hasAccount })
      .from(clients)
      .where(eq(clients.id, subjectId))
      .limit(1);
    if (!row || !row.hasAccount) return { state: 'gone' };
    const state = sessionStateOf(row.status);
    if (state === 'gone') return { state };
    if (state === 'suspended') return { state, name: row.name };
    const kind = await this.ranks.kindOf(row.groupId);
    if (kind === undefined) return { state: 'gone' };
    return { state, name: row.name, rank: { id: row.groupId, kind } };
  }
}

/**
 * The directory of subject resolvers.
 *
 * Why: see {@link SessionSubjectResolver}. Staff and accounts are built in. A subject type without a resolver has no valid sessions,
 * which fails closed.
 */
@Injectable()
export class SessionSubjects {
  private readonly resolvers = new Map<SubjectType, SessionSubjectResolver>();

  constructor(db: DbService, ranks: RankKinds) {
    this.register(new StaffSubjectResolver(db));
    this.register(new AccountSubjectResolver(db, ranks));
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
   * @param subjectType staff or account
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
   * @param subjectType staff or account
   * @returns true when a resolver is registered
   */
  has(subjectType: SubjectType): boolean {
    return this.resolvers.has(subjectType);
  }
}
