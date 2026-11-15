// The real-time hub of an API process (decision 037): the doorbell subscriber, the registry of open streams, the writer, replay
// and snapshot, the caps, the heartbeat, the metrics and the shutdown. It knows no table: sources render every event.
import type { ServerResponse } from 'node:http';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { CLOCK, type Clock, TIMERS, type Timers } from '../../common/clock';
import { AppError } from '../../common/errors';
import { LogThrottle } from '../../common/log-throttle';
import { REQUEST_ID_HEADER } from '../../common/request-id';
import { surfaceOfPath } from '../../common/surface';
import { withTimeout } from '../../common/timeout';
import { APP_CONFIG, type AppConfig } from '../../config';
import { MetricsService } from '../metrics';
import { RateLimitService, rateLimitedError } from '../rate-limit';
import { RedisService } from '../redis';
import { type BucketTicker, ConnectionRegistry, type RegisteredStream, startBucketTicker } from './connection-registry';
import { RealtimeHubMetrics, type RefusalReason } from './realtime-metrics';
import { realtimeChannel } from './realtime-publisher';
import { RealtimeSources, SESSION_TOPIC } from './realtime-sources';
import type { CapKey, Delivery, Doorbell, Frame, RealtimeSource, StreamViewer } from './realtime.types';
import { formatStreamCursor, parseStreamCursor } from './stream-cursor';
import { MAX_FRAME_BYTES, STREAM_HEADERS, StreamWriter, frameData, frameText, retryText } from './stream-writer';

/** How many rows a source may replay for one reconnect; the inbox replays at most 50 of them (plan § 3.6). */
export const REPLAY_LIMIT = 100;
/** Live frames that wait while a stream replays; one more sends `resync` for its topic instead. */
export const MAX_PENDING_FRAMES = 100;
/** Doorbells resolved at once (each reads Postgres; the pool has 10 connections). */
export const MAX_DOORBELLS_IN_FLIGHT = 4;
/** Doorbells that wait; one more is dropped and every stream gets `resync` once the queue drained. */
export const MAX_DOORBELLS_WAITING = 1000;
/** The hub's one timer: one heartbeat bucket per second. */
export const TICK_MS = 1000;
/** Extra lifetime of a stream, spread so that streams opened together do not reconnect together. */
export const MAX_AGE_JITTER_MS = 120_000;
/** How long a shutdown waits for the ended streams to close before it destroys their sockets. */
const SHUTDOWN_WAIT_MS = 2000;
/** How long the boot waits for the first SUBSCRIBE before it lets the app start anyway. */
const SUBSCRIBE_WAIT_MS = 3000;
const LOG_INTERVAL_MS = 30_000;

/** What `open` needs: who, with which caps, on which request, and the cursor the client sent back. */
export interface OpenStreamInput {
  /** The person the guard authenticated. */
  readonly viewer: StreamViewer;
  /** The caps the stream counts against; the first is also the key of the `stream-connect` limiter. */
  readonly caps: readonly CapKey[];
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  /** The `Last-Event-ID` header or the `cursor` query (`streamCursorOf`); garbage is a fresh start. */
  readonly cursor?: string;
}

/** Why a stream ended (`realtime_connections_closed_total{reason}` and the `stream closed` log line). */
type CloseReason =
  'client_closed' | 'max_age' | 'shutdown' | 'session_ended' | 'reauth' | 'slow_consumer' | 'write_error' | 'error';

/** A frame made ready for one connection (or shared by all of a delivery). */
interface Prepared {
  /** The source topic; empty for the hub's own events (`resync`). */
  readonly topic: string;
  readonly letter: string;
  readonly event: string;
  readonly json: string;
  readonly cursor: number | undefined;
  /** The doorbell's time, for the delivery histogram; absent for replay and snapshot frames. */
  readonly at: number | undefined;
}

/** One open stream. */
interface Connection extends RegisteredStream {
  readonly viewer: StreamViewer;
  readonly surface: string;
  readonly route: string;
  readonly requestId: string;
  readonly raw: ServerResponse;
  readonly writer: StreamWriter;
  /** The position per source letter: the composite cursor of the next `id:`. */
  readonly parts: Map<string, number>;
  state: 'replaying' | 'live' | 'closing';
  /** Live frames that arrived during the replay. */
  readonly pending: Prepared[];
  /** Topics whose live frames overflowed the pending list (they get `resync`). */
  readonly overflowed: Set<string>;
  frames: number;
  readonly openedAtMs: number;
  readonly closeAtMs: number;
  /** Resolves when the response closed (the shutdown waits for it). */
  readonly closed: Promise<void>;
}

/** The refusal reason of a full cap, from the cap key's prefix (`session:91` is `session_cap`). */
function capReason(key: string): RefusalReason {
  const prefix = key.slice(0, key.indexOf(':'));
  if (prefix === 'session' || prefix === 'ip' || prefix === 'ticket') return `${prefix}_cap`;
  return 'cap';
}

/** Parses a doorbell; anything that is not one is `undefined`. */
function parseDoorbell(message: string): Doorbell | undefined {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { v, topic, op, at } = value as Record<string, unknown>;
  if (v !== 1 || typeof topic !== 'string' || typeof op !== 'string' || typeof at !== 'number') return undefined;
  return value as Doorbell;
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Whether a stream ended; a function, because any write may end it (TypeScript would keep an earlier narrowing). */
const ended = (connection: { readonly state: string }): boolean => connection.state === 'closing';

/**
 * The live streams of this API process.
 *
 * Why: decision 037: one SSE stream per signed-in browser and surface. A change rings a doorbell (ids only); the hub hands it to
 * its source, which re-reads Postgres with the viewer's rights, and writes the result to the streams of the audience keys. A
 * reconnect replays what it missed, bounded, or gets `resync`. Streams are capped per session, per address and in total (the
 * newest is refused), get a heartbeat every 15 s, end after 15 minutes (the guard then runs again) and when their session ends,
 * and a client that does not read is dropped, never buffered.
 *
 * Side effects: one Redis subscriber connection (`gsm-realtime-sub`); the `stream-connect` rate limiter; writes to hijacked
 * responses; the `realtime_*` metrics; `stream opened` (debug) and `stream closed` log lines (never a cookie, token, cursor or
 * text).
 *
 * @see docs/decisions/037-realtime-sse.md
 */
@Injectable()
export class RealtimeHub implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeHub.name);
  private readonly throttle = new LogThrottle(LOG_INTERVAL_MS);
  private readonly settings: AppConfig['realtime'];
  private readonly channel: string;
  private readonly registry: ConnectionRegistry<Connection>;
  private readonly metrics: RealtimeHubMetrics;
  private readonly waiting: Array<() => Promise<void>> = [];
  private inFlight = 0;
  private resyncWhenDrained = false;
  private nextId = 1;
  private closing = false;
  private subscribed = false;
  private subscriber: Redis | undefined;
  private ticker: BucketTicker | undefined;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly redis: RedisService,
    private readonly sources: RealtimeSources,
    private readonly rateLimits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TIMERS) private readonly timers: Timers,
    metrics: MetricsService,
  ) {
    this.settings = config.realtime;
    this.channel = realtimeChannel(config);
    this.registry = new ConnectionRegistry(config.realtime.heartbeatSeconds);
    this.metrics = new RealtimeHubMetrics(metrics.registry);
  }

  /** @returns how many streams are open in this process */
  get size(): number {
    return this.registry.size;
  }

  /** @returns true while the subscriber is subscribed to the doorbell channel */
  get listening(): boolean {
    return this.subscribed;
  }

  /**
   * Subscribes to the doorbell channel (after every module registered its source).
   *
   * Why: a Redis that is down must not stop the API: the subscriber keeps reconnecting, and its first `ready` sends `resync` to
   * the streams opened meanwhile. The heartbeat starts with the first stream (an idle process has no timer).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.settings.enabled) return;
    const subscriber = this.redis.createSubscriberConnection();
    this.subscriber = subscriber;
    subscriber.on('message', (channel: string, message: string) => this.onMessage(channel, message));
    subscriber.on('ready', () => this.onSubscriberReady(subscriber));
    subscriber.on('close', () => {
      this.subscribed = false;
      this.metrics.subscriberUp.set(0);
    });
    const subscribing = subscriber.subscribe(this.channel);
    // A subscribe that waits for a Redis that is down is flushed with an error when the connection is closed at shutdown.
    subscribing.catch(() => undefined);
    // The cache client already waited for Redis at start: when it is down, the boot does not wait a second time.
    if (this.redis.cache.status === 'ready') {
      try {
        await withTimeout(subscribing, SUBSCRIBE_WAIT_MS, 'Redis subscribe');
        return;
      } catch {
        // Logged below.
      }
    }
    this.logger.warn('The real-time subscriber is not subscribed yet; it keeps retrying in the background');
  }

  /**
   * Ends every stream with `bye` `shutdown`, waits at most 2 s for them to close, destroys the rest and unsubscribes.
   *
   * Why: Nest closes the HTTP server after `onModuleDestroy`; an open stream would hold it. The browsers reconnect to the next
   * process by themselves. The subscriber connection itself closes in `RedisService.onApplicationShutdown`.
   */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.ticker?.stop();
    this.ticker = undefined;
    const open = this.registry.all();
    for (const connection of open) this.bye(connection, 'shutdown');
    await withTimeout(
      Promise.all(open.map((connection) => connection.closed)),
      SHUTDOWN_WAIT_MS,
      'live streams to close',
    ).catch(() => {
      for (const connection of open) if (!connection.raw.destroyed) connection.raw.destroy();
    });
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (subscriber && subscriber.status === 'ready') {
      await withTimeout(subscriber.unsubscribe(this.channel), SHUTDOWN_WAIT_MS, 'Redis unsubscribe').catch(
        () => undefined,
      );
    }
  }

  /**
   * Opens a stream: refuses it, or answers 200 `text/event-stream`, writes `ready`, replays, writes the snapshot and goes live.
   *
   * Why: decision 037 (plan § 3.4). Every refusal happens before the stream starts and is an ordinary problem+json answer. The
   * stream is registered before it reads anything, so a change that commits while it replays is held and written after the
   * replay (unless the replay already had it).
   *
   * @param input the viewer, the caps, the request and reply, and the cursor the client sent back
   * @returns when the stream is live (or ended early); the response stays open
   * @throws {AppError} `UNAVAILABLE` (503, `Retry-After: 30`) when streams are switched off, the process shuts down or is full;
   *   `RATE_LIMITED` (429, `Retry-After`) when the `stream-connect` limiter or a cap refuses (detail `Too many open live
   *   connections.`, `Retry-After: 60`)
   */
  async open(input: OpenStreamInput): Promise<void> {
    const { viewer, caps, request, reply } = input;
    const route = request.routeOptions?.url ?? 'unmatched';
    const surface = surfaceOfPath(route);
    const first = caps[0];
    if (!first) throw new Error('A stream needs at least one cap');
    this.assertAccepting(surface);
    const limited = await this.rateLimits.consume('stream-connect', first.key);
    if (!limited.allowed) {
      this.metrics.refused.inc({ surface, reason: 'rate' });
      throw rateLimitedError(limited.retryAfterSeconds);
    }
    this.assertAccepting(surface);
    const full = this.registry.fullCap(caps);
    if (full) {
      this.metrics.refused.inc({ surface, reason: capReason(full.key) });
      throw new AppError('RATE_LIMITED', { detail: 'Too many open live connections.', retryAfterSeconds: 60 });
    }

    const sources = this.sources.all();
    const accepted = parseStreamCursor(input.cursor, new Set(sources.map((source) => source.cursorKey)));
    const raw = reply.raw;
    let markClosed: () => void = () => undefined;
    const openedAtMs = this.clock.nowMs();
    const connection: Connection = {
      id: this.nextId++,
      keys: this.keysOf(viewer, sources),
      caps,
      sessionId: viewer.sessionId,
      viewer,
      surface,
      route,
      requestId: request.id,
      raw,
      writer: new StreamWriter(raw),
      parts: new Map(),
      state: 'replaying',
      pending: [],
      overflowed: new Set(),
      frames: 0,
      openedAtMs,
      closeAtMs: openedAtMs + this.settings.maxAgeSeconds * 1000 + Math.floor(Math.random() * MAX_AGE_JITTER_MS),
      closed: new Promise<void>((resolve) => (markClosed = resolve)),
    };
    // Registered before anything is read, so the caps count it and a doorbell that rings meanwhile waits in `pending`.
    this.registry.add(connection);
    this.ticker ??= startBucketTicker(this.timers, this.registry.bucketCount, TICK_MS, (index) => this.onTick(index));
    this.metrics.opened.inc({ surface });
    this.metrics.connections.inc({ surface });

    for (const [name, value] of Object.entries(STREAM_HEADERS)) void reply.header(name, value);
    // The onSend hook that echoes the request id never runs for a hijacked reply.
    void reply.header(REQUEST_ID_HEADER, request.id);
    reply.hijack();
    const onClose = () => {
      markClosed();
      this.finish(connection, 'client_closed');
    };
    raw.once('close', onClose);
    request.raw.once('close', onClose);
    raw.on('error', () => this.drop(connection, 'write_error'));
    try {
      raw.writeHead(200, headersOf(reply));
      raw.flushHeaders();
    } catch (error) {
      this.logFailure('start', error);
      this.drop(connection, 'write_error');
      return;
    }
    // A client that left before the listeners were attached sends no close event any more.
    if (raw.destroyed || request.raw.destroyed) {
      onClose();
      return;
    }
    this.logger.debug({ msg: 'stream opened', ...this.logFields(connection) });

    // A random 2 to 5 s spreads the browsers' own reconnects after a restart.
    this.write(connection, retryText(2000 + Math.random() * 3000), undefined);
    this.writeEvent(connection, 'ready', {
      v: 1,
      heartbeatMs: this.settings.heartbeatSeconds * 1000,
      resumed: accepted.size > 0,
      serverTime: this.clock.now().toISOString(),
    });
    try {
      await this.catchUp(connection, sources, accepted);
    } catch (error) {
      this.logFailure('catch-up', error);
      if (!ended(connection)) {
        connection.raw.end();
        this.finish(connection, 'error');
      }
    }
  }

  /** Refuses new streams while switched off, shutting down or full. */
  private assertAccepting(surface: string): void {
    const reason: RefusalReason | undefined =
      !this.settings.enabled || this.closing
        ? 'disabled'
        : this.registry.size >= this.settings.maxConnections
          ? 'capacity'
          : undefined;
    if (!reason) return;
    this.metrics.refused.inc({ surface, reason });
    throw new AppError('UNAVAILABLE', {
      detail: 'Live updates are not available right now. The page keeps refreshing on its own.',
      retryAfterSeconds: 30,
    });
  }

  /** The audience keys of a viewer: `u:<kind>:<id>` for an account, plus what each source adds. */
  private keysOf(viewer: StreamViewer, sources: readonly RealtimeSource[]): string[] {
    const keys = new Set<string>(viewer.kind === 'ticket' ? [] : [`u:${viewer.kind}:${viewer.id}`]);
    for (const source of sources) for (const key of source.keysFor(viewer)) keys.add(key);
    return [...keys];
  }

  /** Replay (or head) per source, `resync` where too much was missed, the held live frames, the snapshot, then live. */
  private async catchUp(
    connection: Connection,
    sources: readonly RealtimeSource[],
    accepted: ReadonlyMap<string, number>,
  ): Promise<void> {
    const { viewer } = connection;
    const resync: string[] = [];
    for (const source of sources) {
      if (ended(connection)) return;
      const letter = source.cursorKey;
      const after = accepted.get(letter);
      if (after === undefined) {
        this.advance(connection, letter, await source.head(viewer));
        this.metrics.replays.inc({ outcome: 'fresh' });
        continue;
      }
      const frames = await source.replay(viewer, after, REPLAY_LIMIT);
      if (frames === 'resync') {
        resync.push(source.topic);
        this.advance(connection, letter, await source.head(viewer));
        this.metrics.replays.inc({ outcome: 'resync' });
        continue;
      }
      this.advance(connection, letter, after);
      this.metrics.replays.inc({ outcome: 'replayed' });
      for (const frame of frames) {
        const prepared = this.prepare(source, frame, viewer, undefined);
        if (prepared) this.emit(connection, prepared, true);
      }
    }
    if (ended(connection)) return;
    if (resync.length > 0) this.writeEvent(connection, 'resync', { topics: resync });
    this.flushPending(connection);
    for (const source of sources) {
      const frames = await source.snapshot(viewer);
      if (ended(connection)) return;
      for (const frame of frames) {
        const prepared = this.prepare(source, frame, viewer, undefined);
        if (prepared) this.emit(connection, prepared, true);
      }
    }
    if (ended(connection)) return;
    // Whatever arrived during the snapshot is written now, in the same task as the switch: nothing falls between the two.
    this.flushPending(connection);
    if (!ended(connection)) connection.state = 'live';
  }

  /** Moves a source's part of the cursor forward (never back). */
  private advance(connection: Connection, letter: string, id: number): void {
    const current = connection.parts.get(letter);
    if (current === undefined || id > current) connection.parts.set(letter, id);
  }

  /** Writes the live frames held during the replay that the replay did not already have; `resync` for overflowed topics. */
  private flushPending(connection: Connection): void {
    const held = connection.pending.splice(0);
    if (connection.overflowed.size > 0) {
      this.writeEvent(connection, 'resync', { topics: [...connection.overflowed] });
    }
    for (const frame of held) {
      if (connection.overflowed.has(frame.topic)) continue;
      const seen = connection.parts.get(frame.letter);
      if (frame.cursor !== undefined && seen !== undefined && frame.cursor <= seen) continue;
      this.emit(connection, frame, true);
    }
    connection.overflowed.clear();
  }

  /** Serialises a frame for a viewer; a frame that fails or is too large is logged, counted and skipped. */
  private prepare(
    source: RealtimeSource,
    frame: Frame,
    viewer: StreamViewer,
    at: number | undefined,
  ): Prepared | undefined {
    try {
      const value =
        typeof frame.data === 'function' ? (frame.data as (viewer: StreamViewer) => unknown)(viewer) : frame.data;
      const json = frameData(value);
      if (Buffer.byteLength(json) > MAX_FRAME_BYTES) {
        this.metrics.drops.inc({ reason: 'frame_too_large' });
        this.logFailure(`frame ${frame.event}`, new Error(`over ${MAX_FRAME_BYTES} bytes`));
        return undefined;
      }
      return { topic: source.topic, letter: source.cursorKey, event: frame.event, json, cursor: frame.cursor, at };
    } catch (error) {
      this.metrics.drops.inc({ reason: 'invalid_frame' });
      this.logFailure(`frame ${frame.event}`, error);
      return undefined;
    }
  }

  /** Writes a prepared frame, or holds it while the stream replays (`direct` writes during the replay itself). */
  private emit(connection: Connection, frame: Prepared, direct = false): void {
    if (connection.state === 'closing') return;
    if (connection.state === 'replaying' && !direct) {
      if (connection.pending.length < MAX_PENDING_FRAMES) connection.pending.push(frame);
      else {
        connection.overflowed.add(frame.topic);
        if (frame.cursor !== undefined) this.advance(connection, frame.letter, frame.cursor);
        this.metrics.drops.inc({ reason: 'replay_overflow' });
      }
      return;
    }
    let id: string | undefined;
    if (frame.cursor !== undefined) {
      this.advance(connection, frame.letter, frame.cursor);
      id = formatStreamCursor(connection.parts, this.letterOrder());
    }
    try {
      this.write(connection, frameText(frame.event, frame.json, id), frame.event, frame.at);
    } catch (error) {
      this.metrics.drops.inc({ reason: 'invalid_frame' });
      this.logFailure(`frame ${frame.event}`, error);
    }
  }

  /** Writes one of the hub's own events (`ready`, `resync`, `bye`). */
  private writeEvent(connection: Connection, event: string, data: unknown): void {
    this.emit(
      connection,
      { topic: '', letter: '', event, json: frameData(data), cursor: undefined, at: undefined },
      true,
    );
  }

  /** Puts text on the wire; a failed write or a client that does not read drops the stream. */
  private write(connection: Connection, text: string, event: string | undefined, at?: number): void {
    if (connection.state === 'closing') return;
    const outcome = connection.writer.write(text);
    if (outcome === 'error') {
      this.drop(connection, 'write_error');
      return;
    }
    if (outcome === 'slow') {
      this.drop(connection, 'slow_consumer');
      return;
    }
    if (event === undefined) return;
    connection.frames += 1;
    this.metrics.eventsSent.inc({ event });
    if (at !== undefined) this.metrics.delivery.observe(Math.max(0, this.clock.nowMs() - at) / 1000);
  }

  private letterOrder(): string[] {
    return this.sources.all().map((source) => source.cursorKey);
  }

  /** Ends a stream politely: `bye` with the reason, then the end of the response. */
  private bye(
    connection: Connection,
    reason: Exclude<CloseReason, 'client_closed' | 'slow_consumer' | 'write_error'>,
  ): void {
    if (ended(connection)) return;
    this.writeEvent(connection, 'bye', { reason });
    if (ended(connection)) return;
    connection.raw.end();
    this.finish(connection, reason);
  }

  /** Drops a stream at once (its socket is destroyed; the client reconnects and replays). */
  private drop(connection: Connection, reason: 'slow_consumer' | 'write_error'): void {
    if (connection.state === 'closing') return;
    this.metrics.drops.inc({ reason });
    connection.raw.destroy();
    this.finish(connection, reason);
  }

  /** Unregisters a stream once, frees its caps and logs `stream closed`. */
  private finish(connection: Connection, reason: CloseReason): void {
    connection.state = 'closing';
    if (!this.registry.remove(connection)) return;
    this.metrics.connections.dec({ surface: connection.surface });
    this.metrics.closed.inc({ surface: connection.surface, reason });
    this.logger.log({ msg: 'stream closed', ...this.logFields(connection), reason });
  }

  /** The fields of the two log lines of a stream: never a cookie, a token, the cursor or a text. */
  private logFields(connection: Connection): Record<string, unknown> {
    return {
      requestId: connection.requestId,
      route: connection.route,
      viewer: `${connection.viewer.kind}:${connection.viewer.id}`,
      sessionId: connection.viewer.sessionId,
      durationMs: this.clock.nowMs() - connection.openedAtMs,
      frames: connection.frames,
    };
  }

  /** One heartbeat tick: `hb` to the bucket's streams, `bye max_age` to those past their age; stops when no stream is left. */
  private onTick(index: number): void {
    const now = this.clock.nowMs();
    const seconds = Math.floor(now / 1000);
    for (const connection of this.registry.bucket(index)) {
      if (connection.state === 'closing') continue;
      if (now >= connection.closeAtMs) {
        this.bye(connection, 'max_age');
        continue;
      }
      this.write(connection, frameText('hb', String(seconds)), 'hb');
    }
    // The last stream is gone: no timer while the process is idle (the next stream starts it again).
    if (this.registry.size === 0) {
      this.ticker?.stop();
      this.ticker = undefined;
    }
  }

  /** After every (re)connect of the subscriber: subscribe again, then `resync` to every stream (doorbells may be lost). */
  private onSubscriberReady(subscriber: Redis): void {
    subscriber.subscribe(this.channel).then(
      () => {
        if (this.closing) return;
        this.subscribed = true;
        this.metrics.subscriberUp.set(1);
        this.resyncAll();
      },
      (error: unknown) => this.logFailure('subscribe', error),
    );
  }

  /** Sends `resync` for every topic to every stream. */
  private resyncAll(): void {
    const topics = this.sources.all().map((source) => source.topic);
    for (const connection of this.registry.all()) {
      if (connection.state === 'replaying') for (const topic of topics) connection.overflowed.add(topic);
      else this.writeEvent(connection, 'resync', { topics });
    }
  }

  private onMessage(channel: string, message: string): void {
    if (channel !== this.channel || this.closing) return;
    const doorbell = parseDoorbell(message);
    if (!doorbell) {
      this.metrics.drops.inc({ reason: 'bad_doorbell' });
      return;
    }
    const source = this.sources.get(doorbell.topic);
    if (doorbell.topic !== SESSION_TOPIC && !source) return;
    this.metrics.doorbellsReceived.inc({ topic: doorbell.topic });
    if (doorbell.topic === SESSION_TOPIC) {
      this.onSessionDoorbell(doorbell);
      return;
    }
    if (!source || this.registry.size === 0) return;
    this.enqueue(() => this.resolve(source, doorbell));
  }

  /** `session ended`: `bye session_ended` to the streams of those sessions; `session subject`: `bye reauth` to the account's. */
  private onSessionDoorbell(doorbell: Doorbell): void {
    if (doorbell.op === 'ended' && Array.isArray(doorbell['sessionIds'])) {
      for (const id of doorbell['sessionIds'] as unknown[]) {
        if (isId(id)) for (const connection of this.registry.ofSession(id)) this.bye(connection, 'session_ended');
      }
      return;
    }
    const { subjectType, subjectId } = doorbell;
    if (doorbell.op === 'subject' && typeof subjectType === 'string' && isId(subjectId)) {
      for (const connection of this.registry.withKeys([`u:${subjectType}:${subjectId}`]))
        this.bye(connection, 'reauth');
    }
  }

  /** At most {@link MAX_DOORBELLS_IN_FLIGHT} at once; overflow drops the doorbell and resyncs everyone once drained. */
  private enqueue(job: () => Promise<void>): void {
    if (this.inFlight < MAX_DOORBELLS_IN_FLIGHT) {
      void this.run(job);
      return;
    }
    if (this.waiting.length >= MAX_DOORBELLS_WAITING) {
      this.metrics.drops.inc({ reason: 'doorbell_overflow' });
      this.resyncWhenDrained = true;
      return;
    }
    this.waiting.push(job);
  }

  private async run(job: () => Promise<void>): Promise<void> {
    this.inFlight += 1;
    try {
      await job();
    } catch (error) {
      this.logFailure('doorbell', error);
    } finally {
      this.inFlight -= 1;
      const next = this.waiting.shift();
      if (next) void this.run(next);
      else if (this.inFlight === 0 && this.resyncWhenDrained) {
        this.resyncWhenDrained = false;
        this.resyncAll();
      }
    }
  }

  private async resolve(source: RealtimeSource, doorbell: Doorbell): Promise<void> {
    const deliveries = await source.resolve(doorbell, (key) => this.registry.has(key));
    for (const delivery of deliveries) this.deliver(source, delivery, doorbell.at);
  }

  /** Writes one delivery to the streams of its keys: serialised once, or once per stream when the data depends on the viewer. */
  private deliver(source: RealtimeSource, delivery: Delivery, at: number): void {
    const targets = this.registry.withKeys(delivery.keys);
    if (targets.size === 0) return;
    if (delivery.close) {
      for (const connection of targets) this.bye(connection, delivery.close);
      return;
    }
    const frame = delivery.frame;
    if (!frame) return;
    const perViewer = typeof frame.data === 'function';
    let shared: Prepared | undefined;
    let sharedReady = false;
    for (const connection of targets) {
      let prepared: Prepared | undefined;
      if (perViewer) prepared = this.prepare(source, frame, connection.viewer, at);
      else {
        if (!sharedReady) {
          shared = this.prepare(source, frame, connection.viewer, at);
          sharedReady = true;
        }
        prepared = shared;
      }
      if (prepared) this.emit(connection, prepared);
    }
  }

  private logFailure(what: string, error: unknown): void {
    const allowed = this.throttle.attempt(what);
    if (!allowed) return;
    const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} more not logged)` : '';
    this.logger.error(`Real-time ${what} failed: ${error instanceof Error ? error.message : String(error)}${more}`);
  }
}

/** The headers already on a reply (CORS, security headers, the request id and the stream's own), for `writeHead`. */
function headersOf(reply: FastifyReply): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}
