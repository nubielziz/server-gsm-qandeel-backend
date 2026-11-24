// The rank kind of a group for the session core (decision 064): a lookup that the application installs at boot, so the security folder
// never imports the catalog or reads `client_groups`.
import { Injectable } from '@nestjs/common';
import type { RankKind } from '../ports/rank-kind';

/**
 * Reads the rank kind of one rank (a group id).
 *
 * @returns the kind, or `undefined` when no rank has that id
 */
export type RankKindLookup = (groupId: number) => Promise<RankKind | undefined>;

/**
 * The rank kind of a group, as the session core needs it when it loads a session.
 *
 * Why: the rank kind of an account decides which routes its session may call (the default-deny rank gate, decision 064), and the rank is
 * a row of the catalog's groups table. The security folder stays free of the catalog: `RankKindsInstaller` (application) installs the
 * lookup at boot, through the catalog's `RankGroupReads`. The one retail rank cannot be deleted or change kind, so its id is kept in
 * memory once it is known; every other rank is read each time (a session view is cached for a minute, so this is one read a minute).
 * Not installed, or no such rank: `undefined`, and the caller refuses the session (fail closed).
 *
 * Side effects: none of its own; the installed lookup reads `client_groups`.
 */
@Injectable()
export class RankKinds {
  private lookup: RankKindLookup | undefined;
  private retailGroupId: number | undefined;

  /**
   * Installs the lookup (the installer calls it once at boot).
   *
   * @param lookup reads the rank kind of a group id
   * @throws {Error} when a lookup is already installed (a boot-time programming error)
   */
  install(lookup: RankKindLookup): void {
    if (this.lookup !== undefined) throw new Error('The rank kind lookup is already installed');
    this.lookup = lookup;
  }

  /**
   * Reads the rank kind of a group.
   *
   * @param groupId the rank of the account (`clients.group_id`)
   * @returns `merchant` or `retail`; `undefined` when no lookup is installed or the rank does not exist
   */
  async kindOf(groupId: number): Promise<RankKind | undefined> {
    if (this.retailGroupId === groupId) return 'retail';
    if (this.lookup === undefined) return undefined;
    const kind = await this.lookup(groupId);
    // One retail row only (unique index): once seen, its id never needs another read.
    if (kind === 'retail') this.retailGroupId = groupId;
    return kind;
  }

  /**
   * Forgets the retail rank id that {@link RankKinds.kindOf} keeps.
   *
   * Why: the id is kept because the one retail rank is never deleted; a test database reset (truncate and restart of the ids) is the
   * one event that gives that rank another id, and a merchant rank that takes the old id would then read as retail.
   *
   * Side effects: the next read of the retail rank goes to the lookup again.
   */
  forgetRetail(): void {
    this.retailGroupId = undefined;
  }
}
