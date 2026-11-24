// ClientGroupDirectory: the read-only view of the ranks (`client_groups`) other modules use: identity (creating a merchant, moving an
// account to another rank, the rank inside an account row) and, through the `RankGroupReads` seam, every module that needs the kind
// of a rank (decision 064). Resolution identity-platform-3.
import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type ClientGroup, clientGroups } from '../db/schema';
import type { ClientGroupKind, RankGroupReads } from '../ports/rank-group-reads';

/** The only group kind that is not for merchants: the storefront's single retail group. */
export const RETAIL_GROUP_KIND = 'b2c_retail';

/** What other modules may know about a merchant group. */
export interface ClientGroupRef {
  readonly id: number;
  readonly name: string;
  /** `b2b` or `b2c_retail`; a merchant can never be put in the retail group. */
  readonly kind: string;
  /** The discount as the database prints it (`'4.0000'`), a wire `Decimal`. */
  readonly discountPercent: string;
  readonly isDefault: boolean;
  /** Whether merchants of the group may have a credit limit above zero (user rule 2). */
  readonly overdraftAllowed: boolean;
  /** The most a merchant of the group may add in one deposit (`'0.0000'` = no per-deposit limit). */
  readonly depositLimit: string;
}

/** How {@link ClientGroupDirectory.find} reads a group. */
export interface FindGroupOptions {
  /**
   * `share` takes a row lock (`FOR SHARE`) kept until the caller's transaction ends.
   *
   * Why: a merchant move, a credit limit change and a group change of `overdraftAllowed` or a group delete must not interleave
   * (user rule 2): the group routes lock the row `FOR UPDATE`, so a reader that decides on the group's flags and then writes
   * takes this shared lock first.
   */
  readonly lock?: 'share';
}

function toRef(row: ClientGroup): ClientGroupRef {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    discountPercent: row.discountPercent,
    isDefault: row.isDefault,
    overdraftAllowed: row.overdraftAllowed,
    depositLimit: row.depositLimit,
  };
}

/**
 * Reads ranks for modules that do not own the `client_groups` table.
 *
 * Why: RESOLUTIONS identity-platform-3: creating a merchant needs the chosen group (or the default one) to exist, to be a
 * merchant group and to say whether credit is allowed, and merchant rows show the group's name and discount. The catalog
 * module owns the table, so the other modules ask this directory (module ownership, decision 016). It also implements
 * {@link RankGroupReads} (decision 064): the kind of a rank, the one retail rank, a rank's name for the rank history and the rank order
 * of the staff list of accounts, so no other module reads the table.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class ClientGroupDirectory implements RankGroupReads {
  /**
   * Finds a group by id.
   *
   * @param db the database or the caller's transaction
   * @param id the group id
   * @param options `{ lock: 'share' }` to keep the row locked until the transaction ends (see {@link FindGroupOptions})
   * @returns the group, or `undefined` when it does not exist
   */
  async find(db: DbExecutor, id: number, options: FindGroupOptions = {}): Promise<ClientGroupRef | undefined> {
    const query = db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
    const [row] = await (options.lock === 'share' ? query.for('share') : query);
    return row ? toRef(row) : undefined;
  }

  /**
   * Finds the default group (the one new merchants join).
   *
   * @param db the database or the caller's transaction
   * @returns the default group, or `undefined` when none is marked
   */
  async findDefault(db: DbExecutor): Promise<ClientGroupRef | undefined> {
    const [row] = await db.select().from(clientGroups).where(eq(clientGroups.isDefault, true)).limit(1);
    return row ? toRef(row) : undefined;
  }

  /**
   * Finds the storefront's retail group (kind `b2c_retail`; at most one exists).
   *
   * Why: the storefront prices every service for this group and the retail floor applies to it (catalog-12, b2c-7).
   *
   * @param db the database or the caller's transaction
   * @returns the retail group, or `undefined` when none exists (a fresh database before migration 0005)
   */
  async findRetail(db: DbExecutor): Promise<ClientGroupRef | undefined> {
    const [row] = await db.select().from(clientGroups).where(eq(clientGroups.kind, RETAIL_GROUP_KIND)).limit(1);
    return row ? toRef(row) : undefined;
  }

  /**
   * Finds several groups at once (one query for a whole page of merchants).
   *
   * @param db the database or the caller's transaction
   * @param ids the group ids; duplicates are fine
   * @returns the groups that exist, by id
   */
  async refsOf(db: DbExecutor, ids: readonly number[]): Promise<Map<number, ClientGroupRef>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await db.select().from(clientGroups).where(inArray(clientGroups.id, unique));
    return new Map(rows.map((row) => [row.id, toRef(row)]));
  }

  /**
   * Reads the kind of a rank ({@link RankGroupReads.kindOf}).
   *
   * Why: the kind decides an account's rights and its wallet (`rankKindOf`); the identity, money and rank-change code ask here
   * instead of reading `client_groups` (decision 064).
   *
   * @param db the database or the caller's transaction
   * @param groupId the rank
   * @returns the stored kind (`b2b` or `b2c_retail`), or `undefined` when the rank does not exist
   */
  async kindOf(db: DbExecutor, groupId: number): Promise<ClientGroupKind | undefined> {
    const [row] = await db
      .select({ kind: clientGroups.kind })
      .from(clientGroups)
      .where(eq(clientGroups.id, groupId))
      .limit(1);
    return row?.kind;
  }

  /**
   * Finds the one retail rank ({@link RankGroupReads.retailGroupId}).
   *
   * Why: every guest and every retail account belongs to it, and the shop prices from it (decision 064; the index
   * `client_groups_single_retail_uq` allows one).
   *
   * @param db the database or the caller's transaction
   * @returns the id of the rank of kind `b2c_retail`
   * @throws {Error} when the catalog has no retail rank (a seeding error: migration 0005 inserts it)
   */
  async retailGroupId(db: DbExecutor): Promise<number> {
    const retail = await this.findRetail(db);
    if (!retail) throw new Error('The catalog has no retail rank (a client group of kind b2c_retail).');
    return retail.id;
  }

  /**
   * Reads the name of a rank ({@link RankGroupReads.nameOf}).
   *
   * Why: the rank history keeps the names of both ranks as they were, so a rank deleted afterwards stays readable.
   *
   * @param db the database or the caller's transaction
   * @param groupId the rank
   * @returns the name, or `undefined` when the rank does not exist
   */
  async nameOf(db: DbExecutor, groupId: number): Promise<string | undefined> {
    const [row] = await db
      .select({ name: clientGroups.name })
      .from(clientGroups)
      .where(eq(clientGroups.id, groupId))
      .limit(1);
    return row?.name;
  }

  /**
   * Lists every rank in rank order ({@link RankGroupReads.rankOrder}).
   *
   * Why: the staff list of accounts sorts by rank in one query; the order is the one of the ranks page (`sort`, then id), so the
   * list and the page never disagree.
   *
   * @param db the database or the caller's transaction
   * @returns the ids of every rank, ordered by `client_groups.sort`, then by id
   */
  async rankOrder(db: DbExecutor): Promise<number[]> {
    const rows = await db
      .select({ id: clientGroups.id })
      .from(clientGroups)
      .orderBy(asc(clientGroups.sort), asc(clientGroups.id));
    return rows.map((row) => row.id);
  }
}
