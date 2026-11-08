// TopUpScreeningHooks: the leaf through which the risk module screens a wallet top-up before the automatic credit posts it
// (RESOLUTIONS money-3), without money importing risk (decision 032: money -> risk -> orders -> money would be a cycle).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';

/** What the automatic credit knows about a top-up that risk may judge. */
export interface TopUpScreeningFacts {
  /** The gateway's card fingerprint of the payment (`payments.card_fingerprint`), when the gateway gave one. */
  readonly cardFingerprint: string | null;
  /** The email of the merchant that is topping up, when known. */
  readonly email: string | null;
}

/** The answer of a hook (or of the whole list): whether the top-up must wait for staff and the sentence for the payment's note. */
export interface TopUpScreeningAnswer {
  readonly flagged: boolean;
  /** The sentence for `payments.review_note` when flagged, else `null`. */
  readonly reason: string | null;
}

/** Someone who may flag a top-up for staff review. */
export interface TopUpScreeningHook {
  /**
   * Judges a top-up. Throwing stops the credit of this payment for this tick (it stays due and is tried again).
   *
   * @param db the credit's transaction
   * @param facts what is known about the top-up
   * @returns whether it is flagged and why
   */
  screenTopUp(db: DbExecutor, facts: TopUpScreeningFacts): Promise<TopUpScreeningAnswer>;
}

/**
 * The list of hooks the automatic credit asks before it credits a top-up.
 *
 * Why: RESOLUTIONS money-3: a flagged automatic top-up gets `review_required` instead of a credit. The rules live in the risk module,
 * which registers its hook at boot (`RiskServicesModule`); the money module only asks the list. An empty list flags nothing, so a
 * process that does not load the risk module credits as before; the worker loads it (see `worker.module.ts`).
 *
 * Side effects: none of its own; a hook reads on the credit's transaction.
 */
@Injectable()
export class TopUpScreeningHooks {
  private readonly hooks: TopUpScreeningHook[] = [];

  /**
   * Adds a hook (called once at boot by the module that holds the rules).
   *
   * @param hook who to ask
   */
  add(hook: TopUpScreeningHook): void {
    this.hooks.push(hook);
  }

  /**
   * Asks every hook until one flags the top-up.
   *
   * @param db the credit's transaction
   * @param facts what is known about the top-up
   * @returns the first flagged answer, else not flagged
   * @throws whatever a hook throws (the payment is not credited this tick: the screen fails closed)
   */
  async screen(db: DbExecutor, facts: TopUpScreeningFacts): Promise<TopUpScreeningAnswer> {
    for (const hook of this.hooks) {
      const answer = await hook.screenTopUp(db, facts);
      if (answer.flagged) return answer;
    }
    return { flagged: false, reason: null };
  }
}
