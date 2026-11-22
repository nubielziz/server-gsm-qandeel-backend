// TrackingTokenSeal: the one-off pass that converts the tracking tokens of storefront orders stored as issued before decision 054 to their keyed hash
// and encrypted copy (orders module); asked for once by migration capability_tokens_seal, run by the worker (job tracking_tokens_seal).
import { Injectable, Logger } from '@nestjs/common';
import { CapabilityTokenVault, type SealOutcome, sealCapabilityTokens } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { findUnsealedOrders, sealOrderToken } from '../infra/tracking.repository';

/** The outbox event migration `capability_tokens_seal` writes once: "seal the tracking tokens stored as issued". */
export const TRACKING_TOKENS_SEAL_EVENT = 'orders.tracking_tokens_seal';

/** The job that event becomes on the `maintenance` queue. */
export const TRACKING_TOKENS_SEAL_JOB = 'tracking_tokens_seal';

/**
 * Seals the tracking tokens of `orders` that are still stored as issued.
 *
 * Why: decision 054: tokens stored as issued before this release get their keyed hash and encrypted copy and lose the plain form; asked
 * for once by migration `capability_tokens_seal`. Each row is its own guarded statement (no long transaction), so a row that changed
 * meanwhile is left alone and a repeat finds nothing to seal.
 *
 * Side effects: updates `orders.public_token`, `public_token_hash` and `public_token_enc` of each converted row (`updated_at` kept); logs one line.
 *
 * @see docs/queues.md (maintenance, `tracking_tokens_seal`)
 */
@Injectable()
export class TrackingTokenSeal {
  private readonly logger = new Logger(TrackingTokenSeal.name);

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
    const outcome = await sealCapabilityTokens(this.vault, 'tracking', {
      unsealed: (afterId, limit) => findUnsealedOrders(this.db.db, afterId, limit),
      seal: (row, sealed) => sealOrderToken(this.db.db, row, sealed),
    });
    this.logger.log(`Sealed ${outcome.sealed} tracking tokens (${outcome.unchanged} changed meanwhile).`);
    return outcome;
  }
}
