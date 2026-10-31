// The processor of the outbox-relay queue (platform module, decision 020): each one-second tick runs one relay pass.
import { Injectable } from '@nestjs/common';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { OutboxRelay, type RelayResult } from './outbox-relay';

/** The job name of the tick that the relay scheduler creates every second. */
export const OUTBOX_TICK_JOB = 'tick';

/**
 * Runs the relay when a tick arrives.
 *
 * Why: the tick is the safety net behind the NOTIFY wake-up (a NOTIFY can be missed while the listener reconnects); it
 * also keeps retrying rows that failed before, as their wait runs out. A tick that finds nothing costs one indexed query.
 * The job fails when the database fails, so a relay that cannot work shows as failed ticks in the System health queue
 * board; it never fails for a queue Redis that is down (the tick could not run then) or for a row that cannot be handed
 * over (those are counted and retried).
 */
@Injectable()
@QueueProcessor('outbox-relay', OUTBOX_TICK_JOB)
export class OutboxRelayProcessor implements JobProcessor<object, RelayResult> {
  constructor(private readonly relay: OutboxRelay) {}

  /**
   * Handles one tick.
   *
   * @returns what the relay did
   */
  process(): Promise<RelayResult> {
    return this.relay.run();
  }
}
