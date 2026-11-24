// AccountRanks: the identity module's writes of the rank and the Dhru username of an account (decision 064).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { type DbExecutor, isUniqueViolation } from '../../../infra/db';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { usernameBase, usernameCandidate } from '../domain/client-rules';
import { isUsernameTaken, lockRankRow, writeGroupId, writeUsernameIfMissing } from './account-ranks.repository';
import { rankKindOf } from '../ports/rank-kind';

/** How many numbered usernames (`name`, `name-2`, ...) are tried before the account's own number is appended. */
const NUMBERED_USERNAMES = 50;

/**
 * Writes the rank and the username of an account.
 *
 * Why: the identity module owns `clients`, and the rank change belongs to the money module (it moves the balance between the two wallet
 * kinds). That use case locks the account, checks every blocker, moves the money and then calls `setRank` here for the one write that
 * is identity's; when an account becomes a merchant it calls `ensureUsername` too, because the Dhru endpoint signs in by username
 * (decision 064). The caller holds the account row lock and has refused every blocker (an open hold, a live order, a frozen wallet): this
 * class only keeps the table's own rules.
 *
 * Side effects: updates `clients.group_id`, `clients.username` and `updated_at`; takes the account row lock again (FOR UPDATE) in the
 * caller's transaction. Time comes from the injected clock (decision 031).
 *
 * @see decision 064
 */
@Injectable()
export class AccountRanks {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly groups: RankGroupReads,
  ) {}

  /**
   * Gives an account another rank.
   *
   * Why: the rank is the account's `group_id`; the rights follow its kind. A guest row always holds the retail rank, so it is refused a
   * merchant rank (staff make an account of it first).
   *
   * Side effects: updates `clients.group_id` and `updated_at`.
   *
   * @param tx the caller's transaction (it holds the account row lock and has done every other check)
   * @param accountId the account
   * @param groupId the new rank
   * @throws {Error} when the account or the rank does not exist, or when a guest row is given a merchant rank (a bug of the caller: the
   *   rank change refuses that case with its own error before it gets here)
   */
  async setRank(tx: DbExecutor, accountId: number, groupId: number): Promise<void> {
    const row = await lockRankRow(tx, accountId);
    if (!row) throw new Error(`Account ${accountId} does not exist.`);
    const kind = await this.groups.kindOf(tx, groupId);
    if (kind === undefined) throw new Error(`Rank ${groupId} does not exist.`);
    if (!row.hasAccount && rankKindOf(kind) === 'merchant') {
      throw new Error(`Account ${accountId} is a guest row and cannot take the merchant rank ${groupId}.`);
    }
    if (row.groupId === groupId) return;
    await writeGroupId(tx, accountId, groupId, this.clock.now());
  }

  /**
   * Returns the Dhru username of an account, making one from its name when it has none.
   *
   * Why: a retail account has no username; the moment its rank becomes a merchant rank it needs one (the merchant signs in to the Dhru
   * endpoint with it). The name is turned into a slug, and a taken slug gets a number (`name-2`, `name-3`, ...). Each write runs in a
   * savepoint, so an account that takes the same username at the same moment makes this one try the next candidate and leaves the
   * caller's transaction alive.
   *
   * Side effects: may update `clients.username` and `updated_at`.
   *
   * @param tx the caller's transaction (it holds the account row lock)
   * @param accountId the account
   * @returns the username the account has now
   * @throws {Error} when the account does not exist, is a guest row (a guest never has a username), or no free username was found
   */
  async ensureUsername(tx: DbExecutor, accountId: number): Promise<string> {
    const row = await lockRankRow(tx, accountId);
    if (!row) throw new Error(`Account ${accountId} does not exist.`);
    if (row.username !== null) return row.username;
    if (!row.hasAccount) throw new Error(`Account ${accountId} is a guest row and cannot have a username.`);
    const base = usernameBase(row.name);
    const candidates = [
      ...Array.from({ length: NUMBERED_USERNAMES }, (_, index) => usernameCandidate(base, index + 1)),
      // Fifty accounts with one name: the account's own number never repeats.
      `${base}-${accountId}`,
    ];
    for (const candidate of candidates) {
      if (await isUsernameTaken(tx, candidate)) continue;
      try {
        const written = await tx.transaction((savepoint) =>
          writeUsernameIfMissing(savepoint, accountId, candidate, this.clock.now()),
        );
        if (written) return candidate;
        // The account got a username between the read and the write (not expected under the row lock): that one stands.
        const current = await lockRankRow(tx, accountId);
        if (current?.username) return current.username;
      } catch (error) {
        if (isUniqueViolation(error, 'clients_username_uq')) continue;
        throw error;
      }
    }
    throw new Error(`No free username was found for account ${accountId}.`);
  }
}
