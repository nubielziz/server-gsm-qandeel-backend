// The relay's wake-up (platform module, decision 020): one dedicated Postgres connection LISTENing on the `outbox` channel.
// Worker only. The one-second scheduler tick is the safety net for a NOTIFY that is missed.
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { PgListener, databaseUrlFor } from '../../../infra/db';
import { OutboxRelay } from './outbox-relay';
import { OUTBOX_CHANNEL } from './outbox.repository';

/**
 * Wakes the relay when an outbox event is committed.
 *
 * Why: decision 020 relays an event within milliseconds of its commit: `OutboxService.add` sends `pg_notify('outbox')`
 * in the writer's transaction, Postgres delivers it at commit, and this listener starts a relay run. The connection is
 * its own `pg.Client` (never a pooled one held for ever), it reconnects after an error with a growing wait and runs a
 * catch-up pass each time it is connected (a NOTIFY sent while it was away is lost; the rows are not), and it is closed in
 * `onModuleDestroy`. The payload of the NOTIFY is ignored: it is a wake-up only.
 *
 * Side effects: holds one Postgres connection named `gsm-outbox-listener` in `pg_stat_activity`.
 */
@Injectable()
export class OutboxListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly listener: PgListener;

  constructor(@Inject(APP_CONFIG) config: AppConfig, relay: OutboxRelay) {
    this.listener = new PgListener({
      connectionString: databaseUrlFor(config),
      channels: [OUTBOX_CHANNEL],
      applicationName: 'gsm-outbox-listener',
      onNotification: () => relay.wake(),
      onConnected: () => relay.wake(),
    });
  }

  /** Connects once; a database that is down is retried in the background and never stops the worker from starting. */
  async onApplicationBootstrap(): Promise<void> {
    await this.listener.start();
  }

  /** Whether the connection is up (health checks and tests). */
  get listening(): boolean {
    return this.listener.listening;
  }

  /** Ends the connection. */
  async onModuleDestroy(): Promise<void> {
    await this.listener.stop();
  }
}
