// RiskGuestClaimParticipant: the risk assessments of a guest row move to the account that proved the mailbox (decision 064),
// registered with identity's `GuestClaimParticipants` when the module starts.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { Transaction } from '../../../infra/db';
import { type GuestClaimIds, GuestClaimParticipants } from '../../identity';
import { lockAssessmentsOfAccountNoWait, moveAssessmentsToAccount } from '../infra/assessment.repository';

/** The name the participant registers under (it keys the counts the claim records). */
export const GUEST_CLAIM_RISK = 'risk_assessments';

/**
 * Moves the risk assessments of a guest row to the account that claims them.
 *
 * Why: the claim runs inside the email-link exchange, after the mailbox was proven, and moves every record of the guest row to the retail
 * account in one transaction (decision 064). Identity runs it but cannot know this module's table, so the module registers a mover. It
 * never waits: the assessments are locked `FOR UPDATE NOWAIT`, so a staff decision or a payment that holds one makes the claim
 * answer `busy` at once (SQLSTATE 55P03, caught by the claim) and the sign-in still succeeds. Only the pointer changes: the score, the
 * signals, the decision and who reviewed it stay as they were. The assessments of the guest row's held orders move with the orders, which
 * the orders participant moves in the same transaction, so the queue card names the account after the claim.
 *
 * Side effects: row locks until the claim's transaction ends; updates `risk_assessments.account_id` and `updated_at`.
 *
 * @see POST /store/v1/auth/verify
 */
@Injectable()
export class RiskGuestClaimParticipant implements OnModuleInit {
  constructor(
    private readonly participants: GuestClaimParticipants,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the mover with the claim. */
  onModuleInit(): void {
    this.participants.register(GUEST_CLAIM_RISK, (tx, ids) => this.move(tx, ids));
  }

  /**
   * Moves the assessments of the guest row.
   *
   * @param tx the claim's transaction, inside the savepoint the claim opened
   * @param ids the guest row and the account
   * @returns how many assessments moved
   * @throws the lock error (SQLSTATE 55P03) when another request holds one of the rows: the claim catches it and answers `busy`
   */
  async move(tx: Transaction, ids: GuestClaimIds): Promise<number> {
    const locked = await lockAssessmentsOfAccountNoWait(tx, ids.guestId);
    return moveAssessmentsToAccount(tx, locked, ids.accountId, this.clock.now());
  }
}
