// ClientGroupDirectory: the read-only view of merchant groups other modules use (identity: creating a merchant, moving it to
// another group, the group inside a merchant row, the nightly promotion ladder). Resolution identity-platform-3, user rule 1.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, asc } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type ClientGroup, clientGroups } from '../db/schema';

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
  /** The spend in USD that promotes a merchant into the group, as the database prints it (`'5000.0000'`); `'0.0000'` = never a target. */
  readonly earnThreshold: string;
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
    earnThreshold: row.earnThreshold,
    depositLimit: row.depositLimit,
  };
}

/**
 * Reads merchant groups for modules that do not own the `client_groups` table.
 *
 * Why: RESOLUTIONS identity-platform-3: creating a merchant needs the chosen group (or the default one) to exist, to be a
 * merchant group and to say whether credit is allowed, and merchant rows show the group's name and discount. The catalog
 * module owns the table, so the other modules ask this directory (module ownership, decision 016).
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class ClientGroupDirectory {
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
   * Lists the groups a merchant can be promoted into, highest threshold first.
   *
   * Why: user rule 1 (RESOLUTIONS catalog-17): the nightly job promotes a merchant to the merchant group with the highest
   * `earn_threshold` above zero that its spend reaches. A group at 0 is never a target and the storefront retail group is
   * never one (a merchant cannot join it). Equal thresholds are ordered by id, so the choice is stable.
   *
   * @param db the database or the caller's transaction
   * @returns the merchant groups with `earn_threshold > 0`, by threshold descending then id ascending
   */
  async promotionLadder(db: DbExecutor): Promise<ClientGroupRef[]> {
    const rows = await db
      .select()
      .from(clientGroups)
      .where(and(eq(clientGroups.kind, 'b2b'), gt(clientGroups.earnThreshold, '0')))
      .orderBy(desc(clientGroups.earnThreshold), asc(clientGroups.id));
    return rows.map(toRef);
  }
}
