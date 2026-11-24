// The boot check of the account wiring (decision 064): before the API answers, every registry the account features rely on holds the
// entries of the modules that own the data. API process only (imported by IdentityModule). The test apps leave it out, as they leave out the
// other boot checks of the real processes (test/support/app.ts): they drop modules on purpose. Its own tests build it.
import { Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { RankChangeGuards } from '../money';
import { GUEST_CLAIM_FILES_NAME } from '../platform';
import { AccountCreateGuards } from './ports/account-create-guards';
import { AccountListSql } from './ports/account-list-sql';
import { GuestClaimParticipants, ORDERS_PARTICIPANT } from './ports/guest-claim-participants';

/**
 * The checks a rank change must run: a live order (orders module) and an open checkout (customers module).
 *
 * Why: without either, a rank change would move the wallet and end the sessions while an order still holds money or a checkout is open.
 *
 * @see POST /admin/clients/:id/rank
 */
export const REQUIRED_RANK_CHANGE_CHECKS: readonly string[] = ['live_order', 'open_checkout'];

/**
 * The participants of the guest claim: orders, checkout sessions and consents (customers), payments and the rest of money, files,
 * risk assessments and tickets (support).
 *
 * Why: a missing participant would leave its records on the guest row after the claim moved the orders.
 *
 * @see POST /store/v1/auth/verify
 */
export const REQUIRED_GUEST_CLAIM_PARTICIPANTS: readonly string[] = [
  ORDERS_PARTICIPANT,
  'customers',
  // The money index exports its name last (its file leads back into identity), so the word is written here: read at load, the export
  // could still be uninitialised when identity's index is the entry point.
  'money',
  GUEST_CLAIM_FILES_NAME,
  'risk_assessments',
  'support',
];

/**
 * The checks a staff create of an account must run: the blocklist (customers module).
 *
 * Why: without it staff could create an account for an email the blocklist refuses.
 *
 * @see POST /admin/clients
 */
export const REQUIRED_ACCOUNT_CREATE_CHECKS: readonly string[] = ['blocklist'];

/** The registries the check reads. */
export interface AccountWiringRegistries {
  readonly rankChangeGuards: RankChangeGuards;
  readonly guestClaims: GuestClaimParticipants;
  readonly createGuards: AccountCreateGuards;
  readonly accountList: AccountListSql;
}

/**
 * Lists what the account registries lack.
 *
 * @param registries the four registries of the process
 * @returns one phrase per missing entry (empty when the wiring is complete), e.g. `rank change check "open_checkout"`
 */
export function missingAccountEntries(registries: AccountWiringRegistries): string[] {
  const missing: string[] = [];
  const lacking = (what: string, required: readonly string[], present: readonly string[]): void => {
    for (const name of required) if (!present.includes(name)) missing.push(`${what} "${name}"`);
  };
  lacking('rank change check', REQUIRED_RANK_CHANGE_CHECKS, registries.rankChangeGuards.names());
  lacking('guest claim participant', REQUIRED_GUEST_CLAIM_PARTICIPANTS, registries.guestClaims.names());
  lacking('account create check', REQUIRED_ACCOUNT_CREATE_CHECKS, registries.createGuards.names());
  // The list's fragments have no name list: asking for one builds plain SQL (no database) or throws when nobody registered it.
  const column = sql`0`;
  if (!builds(() => registries.accountList.orderFigure('ordersCount', column)))
    missing.push('account list fragment "order figures"');
  if (!builds(() => registries.accountList.walletBalance(column)))
    missing.push('account list fragment "wallet balance"');
  return missing;
}

/**
 * Whether a fragment builder returns instead of throwing.
 *
 * @param build the call
 * @returns true when it returned
 */
function builds(build: () => unknown): boolean {
  try {
    build();
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses to boot the API while an account registry lacks an entry.
 *
 * Why: each registry is filled by the module that owns the data, at module init; a module left out of the wiring would not fail on its
 * own, it would let a rank change, a guest claim or a staff create pass without its rule. Failing at boot names the gap before any request
 * (fail closed).
 *
 * Side effects: none; it reads the registries once, after every module's init.
 */
@Injectable()
export class AccountWiringCheck implements OnApplicationBootstrap {
  constructor(
    private readonly rankChangeGuards: RankChangeGuards,
    private readonly guestClaims: GuestClaimParticipants,
    private readonly createGuards: AccountCreateGuards,
    private readonly accountList: AccountListSql,
  ) {}

  /**
   * Checks the registries.
   *
   * @throws {Error} naming every missing entry (the API does not start)
   */
  onApplicationBootstrap(): void {
    const missing = missingAccountEntries({
      rankChangeGuards: this.rankChangeGuards,
      guestClaims: this.guestClaims,
      createGuards: this.createGuards,
      accountList: this.accountList,
    });
    if (missing.length > 0) {
      throw new Error(`The account wiring is incomplete (decision 064): missing ${missing.join(', ')}`);
    }
  }
}

/**
 * Provides the boot check of the account wiring.
 *
 * Why: a module of its own, so the test apps can leave it out by class while the real API always runs it.
 */
@Module({ providers: [AccountWiringCheck] })
export class AccountWiringCheckModule {}
