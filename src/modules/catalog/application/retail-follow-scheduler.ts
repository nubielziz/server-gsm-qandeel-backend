// RetailFollowScheduler: asks for a follow pass whenever the catalog price version moves (decision 040, plan 31 section 6.4). It lives in
// the global CatalogPricesModule, so every process that can move the version (the API and the worker) can ask.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { type PriceVersionListener, PriceVersionListeners } from './price-version-listeners';

/** The job of the follow pass, on the `maintenance` queue. */
export const RETAIL_FOLLOW_JOB = 'retail_price_follow';
/** A pass runs at most once a minute and waits this long after the first change, so a burst of edits is one pass. */
export const RETAIL_FOLLOW_DELAY_MS = 60_000;

/**
 * Asks for a follow pass after every move of the catalog price version.
 *
 * Why: plan 31 section 6.4: following prices must move at most about a minute after what feeds them changed, and every writer of a
 * cost, a floor or a rule already bumps the version. A rule edit, `retailPricing: 'rule'`, a base price and a B2B rule are written in
 * the API, so the listener cannot live in the worker alone: that would leave them to the hourly run.
 *
 * Side effects: `schedule` adds a delayed job to the `maintenance` queue.
 *
 * @see docs/queues.md (maintenance, retail_price_follow)
 */
@Injectable()
export class RetailFollowScheduler implements PriceVersionListener, OnModuleInit {
  private readonly logger = new Logger(RetailFollowScheduler.name);

  constructor(
    private readonly queues: QueuesService,
    private readonly listeners: PriceVersionListeners,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers with the price version, so every move of it asks for a pass. */
  onModuleInit(): void {
    this.listeners.add(this);
  }

  /** Called by the price version after it moved: asks for a pass. */
  async priceVersionMoved(): Promise<void> {
    await this.schedule();
  }

  /**
   * Asks for a pass soon. Never throws: a price change must not fail because the queue is away (the next change, or the hourly run,
   * asks again).
   *
   * @returns true when a job was added or already waits for this minute
   */
  async schedule(): Promise<boolean> {
    try {
      const minute = Math.floor(this.clock.nowMs() / 60_000);
      await this.queues.add(
        'maintenance',
        RETAIL_FOLLOW_JOB,
        {},
        { jobId: queueJobId('retail-follow', minute), delay: RETAIL_FOLLOW_DELAY_MS },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not schedule the retail price follow pass: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
