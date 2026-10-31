// A dedicated Postgres LISTEN connection that reconnects by itself (decision 020: the outbox relay wakes on NOTIFY).
// It holds one connection outside the pool, so a LISTEN never takes a pooled connection for ever.
import { Logger } from '@nestjs/common';
import { Client, type ClientConfig } from 'pg';
import { LogThrottle } from '../../common/log-throttle';
import { withTimeout } from '../../common/timeout';

/** What the listener needs from a `pg.Client`; tests pass a fake. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string | undefined }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

/** Settings of {@link PgListener}. */
export interface PgListenerOptions {
  /** Postgres connection string (the same database as the pool). */
  readonly connectionString: string;
  /** Channels to LISTEN on: lower case letters, digits and "_" (they are quoted into the statement). */
  readonly channels: readonly string[];
  /** Shown in `pg_stat_activity`, so an operator can tell this connection from the pool's. */
  readonly applicationName: string;
  /** Called for every NOTIFY; keep it quick (start work, do not wait for it). */
  readonly onNotification: (channel: string, payload: string | undefined) => void;
  /**
   * Called after every successful (re)connect. `reconnect` is true when the listener had been connected before: any NOTIFY
   * sent while it was away was lost, so the owner should do a catch-up pass.
   */
  readonly onConnected?: (info: { reconnect: boolean }) => void;
  /** Builds the client; defaults to `pg.Client`. Tests replace it. */
  readonly createClient?: (config: ClientConfig) => ListenClient;
  /** Wait before the first reconnect attempt and the longest wait (milliseconds); defaults 500 and 10 000. */
  readonly reconnectMs?: { readonly first: number; readonly max: number };
}

const CHANNEL = /^[a-z_][a-z0-9_]*$/;
/** A shutdown must not hang on a connection that no longer answers. */
const END_WAIT_MS = 2_000;
/** A connection that stays down repeats the same error on every attempt; one line per interval is logged. */
const LOG_INTERVAL_MS = 30_000;

/**
 * Keeps one Postgres connection LISTENing on some channels, and brings it back after any failure.
 *
 * Why: the outbox relay (decision 020) wakes on `NOTIFY outbox` so a committed event is relayed within milliseconds
 * instead of waiting for the next one-second tick. A LISTEN needs a connection that stays open, so it has its own
 * `pg.Client` instead of holding a pooled one; it reconnects with a growing, jittered wait when Postgres restarts or
 * the network drops; and it never throws into the process (the caller keeps a polling safety net for missed NOTIFYs).
 *
 * Side effects: opens one connection per instance (`start`), logs failures once per 30 s, ends the connection in `stop`.
 */
export class PgListener {
  private readonly logger = new Logger(PgListener.name);
  private readonly throttle = new LogThrottle(LOG_INTERVAL_MS);
  private readonly createClient: (config: ClientConfig) => ListenClient;
  private readonly reconnectMs: { first: number; max: number };
  private client: ListenClient | undefined;
  private connecting: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  private everConnected = false;

  /**
   * @param options connection, channels and callbacks
   * @throws {RangeError} when a channel name is not a plain lower case identifier
   */
  constructor(private readonly options: PgListenerOptions) {
    for (const channel of options.channels) {
      if (!CHANNEL.test(channel)) throw new RangeError(`"${channel}" is not a valid LISTEN channel name.`);
    }
    this.createClient = options.createClient ?? ((config) => new Client(config));
    this.reconnectMs = { ...(options.reconnectMs ?? { first: 500, max: 10_000 }) };
  }

  /** Whether a connection is open and listening right now. */
  get listening(): boolean {
    return this.client !== undefined;
  }

  /**
   * Makes the first connection attempt and returns; a failure is retried in the background and never thrown.
   *
   * @returns resolves after the first attempt (connected or scheduled to retry)
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  /**
   * Stops listening and ends the connection.
   *
   * @returns resolves when the connection has ended (or after a short wait if it no longer answers)
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // A connection attempt that is already under way ends here too, as soon as it finishes.
    await this.connecting?.catch(() => undefined);
    await this.discard(this.client);
    this.client = undefined;
  }

  private connect(): Promise<void> {
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const client = this.createClient({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName,
      keepAlive: true,
      connectionTimeoutMillis: 5_000,
    });
    // Both events mean the connection is gone; whichever comes first starts the reconnect.
    client.on('error', (error) => this.lost(client, error.message));
    client.on('end', () => this.lost(client, 'the connection ended'));
    client.on('notification', (message) => {
      try {
        this.options.onNotification(message.channel, message.payload);
      } catch (error) {
        this.logger.error(`A NOTIFY handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    try {
      await client.connect();
      for (const channel of this.options.channels) await client.query(`LISTEN "${channel}"`);
    } catch (error) {
      await this.discard(client);
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.stopped) {
      await this.discard(client);
      return;
    }
    this.client = client;
    this.attempt = 0;
    const reconnect = this.everConnected;
    this.everConnected = true;
    if (reconnect) this.logger.log('Postgres LISTEN connection is back');
    try {
      this.options.onConnected?.({ reconnect });
    } catch (error) {
      this.logger.error(`The onConnected handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The connection failed or ended: forget it and schedule a new one. */
  private lost(client: ListenClient, reason: string): void {
    if (client !== this.client) return;
    this.client = undefined;
    void this.discard(client);
    if (!this.stopped) this.fail(reason);
  }

  private fail(reason: string): void {
    const allowed = this.throttle.attempt('listen:down');
    if (allowed) {
      const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} similar failures not logged)` : '';
      this.logger.warn(`Postgres LISTEN connection is down: ${reason}; retrying${more}`);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const base = Math.min(this.reconnectMs.first * 2 ** this.attempt, this.reconnectMs.max);
    this.attempt++;
    // Jitter so that several workers do not reconnect at the same instant after a restart of Postgres.
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  /** Ends a client quietly: its listeners are removed first so a late error cannot start another reconnect. */
  private async discard(client: ListenClient | undefined): Promise<void> {
    if (!client) return;
    client.removeAllListeners();
    // An error after removeAllListeners would be unhandled and crash the process; swallow it.
    client.on('error', () => undefined);
    await withTimeout(client.end(), END_WAIT_MS, 'Ending the LISTEN connection').catch(() => undefined);
  }
}
