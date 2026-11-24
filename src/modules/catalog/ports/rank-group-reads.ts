// The seam to the ranks (decision 064): what kind a group is, which group is the retail rank and what a group is called. Declared here; the
// catalog module's group directory implements it. Other modules never read `client_groups` themselves.
import type { DbExecutor } from '../../../infra/db';
import type { CLIENT_GROUP_KINDS } from '../db/schema';

/** The kinds a client group can have: `b2b` (a merchant rank) or `b2c_retail` (the retail rank). */
export type ClientGroupKind = (typeof CLIENT_GROUP_KINDS)[number];

/**
 * Reads the facts of ranks that other modules need.
 *
 * Why: the rank kind of an account decides its wallet, its routes and its sessions, and the rank is a row of the catalog's groups table
 * (decision 064). Identity, money and the rank change read it through this class, so the table has one reader and the kind-to-rank-kind
 * rule has one place.
 *
 * Side effects (of the implementation): none; reads `client_groups`.
 */
export abstract class RankGroupReads {
  /**
   * Reads the kind of a group.
   *
   * @param db the database or a transaction
   * @param groupId the group
   * @returns the stored kind, or `undefined` when the group does not exist
   */
  abstract kindOf(db: DbExecutor, groupId: number): Promise<ClientGroupKind | undefined>;

  /**
   * Finds the retail rank.
   *
   * @param db the database or a transaction
   * @returns the id of the one group of kind `b2c_retail`
   * @throws {Error} when the catalog has no retail rank (a seeding error)
   */
  abstract retailGroupId(db: DbExecutor): Promise<number>;

  /**
   * Reads the name of a group.
   *
   * Why: the rank history keeps the name and kind of both ranks as they were, so a rank deleted afterwards stays readable.
   *
   * @param db the database or a transaction
   * @param groupId the group
   * @returns the name, or `undefined` when the group does not exist
   */
  abstract nameOf(db: DbExecutor, groupId: number): Promise<string | undefined>;

  /**
   * Lists every rank in rank order.
   *
   * Why: the staff list of accounts sorts by rank (`GET /admin/clients?_sort=rank`) in one query; the list turns these ids into a CASE.
   *
   * @param db the database or a transaction
   * @returns the ids of every group, ordered by `client_groups.sort`, then by id
   */
  abstract rankOrder(db: DbExecutor): Promise<number[]>;
}
