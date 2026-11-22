// CheckoutTokenSeal: the one-off pass that converts the checkout tokens of checkout sessions stored as issued before decision 054 to their keyed hash
// and encrypted copy (customers module); asked for once by migration capability_tokens_seal, run by the worker (job checkout_tokens_seal).
import { Injectable, Logger } from '@nestjs/common';
import { CapabilityTokenVault, type SealOutcome, sealCapabilityTokens } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { findUnsealedSessions, sealSessionToken } from '../infra/checkout.repository';

/** The outbox event migration `capability_tokens_seal` writes once: "seal the checkout tokens stored as issued". */
export const CHECKOUT_TOKENS_SEAL_EVENT = 'customers.checkout_tokens_seal';

/** The job that event becomes on the `maintenance` queue. */
export const CHECKOUT_TOKENS_SEAL_JOB = 'checkout_tokens_seal';

/**
 * Seals the checkout tokens of `checkout_sessions` that are still stored as issued.
 *
 * Why: decision 054: tokens stored as issued before this release get their keyed hash and encrypted copy and lose the plain form; asked
 * for once by migration `capability_tokens_seal`. Each row is its own guarded statement (no long transaction), so a row that changed
 * meanwhile is left alone and a repeat finds nothing to seal.
 *
 * Side effects: updates `checkout_sessions.token`, `token_hash` and `token_enc` of each converted row (`updated_at` kept); logs one line.
 *
 * @see docs/queues.md (maintenance, `checkout_tokens_seal`)
 */
@Injectable()
export class CheckoutTokenSeal {
  private readonly logger = new Logger(CheckoutTokenSeal.name);

  constructor(
    private readonly db: DbService,
    private readonly vault: CapabilityTokenVault,
  ) {}

  /**
   * Walks the unsealed rows by id, a page at a time, and seals each one.
   *
   * @returns how many rows were sealed and how many changed between the read and the write
   */
  async run(): Promise<SealOutcome> {
    const outcome = await sealCapabilityTokens(this.vault, 'checkout', {
      unsealed: (afterId, limit) => findUnsealedSessions(this.db.db, afterId, limit),
      seal: (row, sealed) => sealSessionToken(this.db.db, row, sealed),
    });
    this.logger.log(`Sealed ${outcome.sealed} checkout tokens (${outcome.unchanged} changed meanwhile).`);
    return outcome;
  }
}
