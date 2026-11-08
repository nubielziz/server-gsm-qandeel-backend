// RecoveryOutbox: writes the outbox event of one recovery email (ids only) and registers its queue route (feature 19, decision 020).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';

/**
 * The outbox event type of one recovery email.
 *
 * Why: decision 020: an email is async work. The aggregate is the checkout session; the event carries no payload because the job
 * re-reads the session, its customer and the consent, and builds the link from the session token inside the job (the token is a
 * secret: it never travels in an event, a job or a notification row).
 */
export const CHECKOUT_RECOVERY_EVENT = 'checkout.recovery';

/**
 * Writes the recovery events.
 *
 * Why: the manual send and the automatic reminder queue the same event, so the one job that sends it is the only place a recovery
 * mail is made.
 *
 * Side effects: registers {@link CHECKOUT_RECOVERY_EVENT} with the `notifications` queue at boot (the API and the worker both load
 * this class); `enqueue` inserts one `outbox_events` row.
 */
@Injectable()
export class RecoveryOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers the event type with its queue. */
  onModuleInit(): void {
    this.routes.register({ type: CHECKOUT_RECOVERY_EVENT, queue: 'notifications' });
  }

  /**
   * Writes the event of one recovery email in the caller's transaction.
   *
   * @param tx the caller's transaction
   * @param sessionId the checkout session to email about
   */
  async enqueue(tx: DbExecutor, sessionId: number): Promise<void> {
    await this.outbox.add(tx, {
      type: CHECKOUT_RECOVERY_EVENT,
      aggregateType: 'checkout_sessions',
      aggregateId: sessionId,
    });
  }
}
