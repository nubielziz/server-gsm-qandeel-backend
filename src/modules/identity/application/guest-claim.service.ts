// GuestClaimService: moves the records of a guest row (an email that ordered without signing up) to the account whose holder just proved
// the mailbox (decision 064, the guest-order claim).
import { Injectable } from '@nestjs/common';
import { type Transaction, pgErrorInfo } from '../../../infra/db';
import { AuditService } from '../../platform';
import { AccountDirectory, type AccountRecord } from '../accounts/account-directory';
import { canAct } from '../accounts/account-status';
import { GuestClaimBusy, GuestClaimParticipants, ORDERS_PARTICIPANT } from '../ports/guest-claim-participants';

// Declared in the registry's leaf file (the barrel exports them from there); re-exported for the callers of this file.
export { GuestClaimBusy, ORDERS_PARTICIPANT } from '../ports/guest-claim-participants';

/** The SQLSTATE of `lock_not_available`: `FOR UPDATE NOWAIT` met a row another transaction holds. */
const LOCK_NOT_AVAILABLE = '55P03';

/** What {@link GuestClaimService.claim} answers. */
export interface GuestClaimResult {
  /** How many orders moved (the count of the {@link ORDERS_PARTICIPANT} participant); zero when nothing moved. */
  readonly claimedOrders: number;
  /** `busy` when the claim gave up because a row it needs is held or a participant refused; nothing moved then. */
  readonly skipped?: 'busy';
}

/** The answer when there is nothing to claim. */
const NOTHING: GuestClaimResult = { claimedOrders: 0 };

/**
 * Runs the guest-order claim inside the link exchange.
 *
 * Why: decision 064. A visitor who ordered without signing up leaves a guest row; once the same email proves its mailbox with the
 * sign-in link, the orders and everything that hangs on them belong to the account, if the visitor asks for it. It is offered only to a
 * retail account that may act. The claim never makes the sign-in wait: the caller holds the account row `FOR UPDATE`; here a
 * SAVEPOINT opens, the guest row is taken `FOR UPDATE NOWAIT` and every registered participant takes its own rows the same way. A lock
 * conflict or a participant's refusal rolls back to the savepoint and answers `busy` (a dispute webhook, a refund approval or a
 * crediting holds its rows first and takes the account row after them, so waiting could deadlock). Lock order: the account row, then
 * the guest row, never the reverse (decision 064). The guest row stays, empty; the claim of an email without a guest row, or of a
 * blocked guest row, moves nothing.
 *
 * Side effects: updates the buyer of the participants' rows (orders, checkout sessions, consents, payments, invoices, refunds, disputes,
 * risk assessments, tickets, messages and their files); writes one `audit_logs` row `claimed guest orders` when something moved.
 *
 * @see POST /store/v1/auth/verify
 */
@Injectable()
export class GuestClaimService {
  constructor(
    private readonly directory: AccountDirectory,
    private readonly participants: GuestClaimParticipants,
    private readonly audit: AuditService,
  ) {}

  /**
   * Moves the guest records of an email to the account.
   *
   * @param tx the exchange's transaction, with the account row already held `FOR UPDATE`
   * @param account the account, as read under that lock
   * @returns how many orders moved, and `busy` when the claim gave up (nothing moved then)
   * @throws {Error} whatever a participant or the audit write throws that is not a lock conflict or a {@link GuestClaimBusy}
   */
  async claim(tx: Transaction, account: AccountRecord): Promise<GuestClaimResult> {
    // Retail only, and only a login row that may act: a merchant rank, a guest row itself or a blocked account claims nothing.
    if (account.rankKind !== 'retail' || !account.hasAccount || !canAct(account.status)) return NOTHING;
    const moved = await this.moveInSavepoint(tx, account);
    if (moved === 'busy') return { claimedOrders: 0, skipped: 'busy' };
    if (moved === undefined) return NOTHING;
    const total = Object.values(moved.counts).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      await this.audit.record(tx, {
        action: 'claimed guest orders',
        entityType: 'account',
        entityId: account.id,
        entityLabel: account.name,
        after: { guestId: moved.guestId, ...moved.counts },
      });
    }
    return { claimedOrders: moved.counts[ORDERS_PARTICIPANT] ?? 0 };
  }

  /**
   * Takes the guest row and moves every participant's rows, inside a savepoint.
   *
   * @returns the guest id and the counts by participant, `undefined` when there is no guest row to claim, or `busy`
   */
  private async moveInSavepoint(
    tx: Transaction,
    account: AccountRecord,
  ): Promise<{ readonly guestId: number; readonly counts: Readonly<Record<string, number>> } | 'busy' | undefined> {
    try {
      return await tx.transaction(async (savepoint) => {
        const guest = await this.directory.lockGuestNoWait(savepoint, account.email);
        // A blocked guest row is refused as it is at checkout: nothing moves.
        if (guest === undefined || !canAct(guest.status)) return undefined;
        const counts = await this.participants.moveAll(savepoint, { guestId: guest.id, accountId: account.id });
        return { guestId: guest.id, counts };
      });
    } catch (error) {
      if (error instanceof GuestClaimBusy || pgErrorInfo(error)?.code === LOCK_NOT_AVAILABLE) return 'busy';
      throw error;
    }
  }
}
