// The open streams of one API process (decision 037): indexed by id, audience key and session, with the cap counts and the
// heartbeat buckets. No I/O, no timer per connection: one ticker walks one bucket a second.
import type { Timers } from '../../common/clock';
import type { CapKey } from './realtime.types';

/** What the registry needs to know about a stream. */
export interface RegisteredStream {
  /** Unique in the process; also picks the heartbeat bucket (`id % buckets`). */
  readonly id: number;
  /** The audience keys the stream listens to (`u:customer:42`). */
  readonly keys: readonly string[];
  /** The caps the stream counts against (`session:91`, `ip:203.0.113.9`). */
  readonly caps: readonly CapKey[];
  /** The session behind the stream; `null` for a ticket link (feature 28). */
  readonly sessionId: number | null;
}

/**
 * The connection registry of the hub.
 *
 * Why: a doorbell is resolved for the keys someone listens to (a map lookup, not a scan), a session end closes the session's
 * streams, a cap refuses the newest stream (never closes an older one: tabs must not fight), and the heartbeat visits each stream
 * once per round without a timer per connection.
 */
export class ConnectionRegistry<C extends RegisteredStream> {
  private readonly byId = new Map<number, C>();
  private readonly byKey = new Map<string, Set<C>>();
  private readonly bySession = new Map<number, Set<C>>();
  private readonly capCounts = new Map<string, number>();
  private readonly buckets: Array<Set<C>>;

  /** @param bucketCount how many heartbeat buckets (one is visited per tick) */
  constructor(bucketCount: number) {
    if (!Number.isInteger(bucketCount) || bucketCount < 1) throw new RangeError('A registry needs at least one bucket');
    this.buckets = Array.from({ length: bucketCount }, () => new Set<C>());
  }

  /** @returns how many streams are registered */
  get size(): number {
    return this.byId.size;
  }

  /** @returns how many heartbeat buckets there are */
  get bucketCount(): number {
    return this.buckets.length;
  }

  /**
   * Finds the first cap a new stream would exceed.
   *
   * @param caps the caps of the new stream
   * @returns the first cap already at its `max`, or `undefined` when the stream fits
   */
  fullCap(caps: readonly CapKey[]): CapKey | undefined {
    return caps.find((cap) => (this.capCounts.get(cap.key) ?? 0) >= cap.max);
  }

  /**
   * How many registered streams count against a cap key.
   *
   * @param key a cap key (`session:91`)
   * @returns the count (0 when none)
   */
  capCount(key: string): number {
    return this.capCounts.get(key) ?? 0;
  }

  /**
   * Registers a stream and counts it against its caps.
   *
   * @param stream the stream
   * @throws {Error} when a stream with the same id is registered (a programming error)
   */
  add(stream: C): void {
    if (this.byId.has(stream.id)) throw new Error(`Stream ${stream.id} is registered twice`);
    this.byId.set(stream.id, stream);
    for (const key of new Set(stream.keys)) indexAdd(this.byKey, key, stream);
    if (stream.sessionId !== null) indexAdd(this.bySession, stream.sessionId, stream);
    for (const cap of stream.caps) this.capCounts.set(cap.key, (this.capCounts.get(cap.key) ?? 0) + 1);
    this.buckets[stream.id % this.buckets.length]!.add(stream);
  }

  /**
   * Unregisters a stream and frees its cap counts; a second call does nothing.
   *
   * @param stream the stream
   * @returns true when it was registered
   */
  remove(stream: C): boolean {
    if (this.byId.get(stream.id) !== stream) return false;
    this.byId.delete(stream.id);
    for (const key of new Set(stream.keys)) indexDelete(this.byKey, key, stream);
    if (stream.sessionId !== null) indexDelete(this.bySession, stream.sessionId, stream);
    for (const cap of stream.caps) {
      const left = (this.capCounts.get(cap.key) ?? 1) - 1;
      if (left > 0) this.capCounts.set(cap.key, left);
      else this.capCounts.delete(cap.key);
    }
    this.buckets[stream.id % this.buckets.length]!.delete(stream);
    return true;
  }

  /**
   * Whether any stream listens to an audience key.
   *
   * @param key an audience key
   * @returns true when at least one stream has it
   */
  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /**
   * The streams that listen to any of the keys, each once.
   *
   * @param keys audience keys
   * @returns the streams
   */
  withKeys(keys: readonly string[]): Set<C> {
    const found = new Set<C>();
    for (const key of keys) for (const stream of this.byKey.get(key) ?? []) found.add(stream);
    return found;
  }

  /**
   * The streams of one session.
   *
   * @param sessionId the session
   * @returns the streams (a copy)
   */
  ofSession(sessionId: number): C[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /**
   * The streams of one heartbeat bucket.
   *
   * @param index the bucket (`0` to `bucketCount - 1`)
   * @returns the streams (a copy, so a stream may be removed while the caller walks it)
   */
  bucket(index: number): C[] {
    return [...(this.buckets[index] ?? [])];
  }

  /**
   * Every registered stream.
   *
   * @returns the streams (a copy)
   */
  all(): C[] {
    return [...this.byId.values()];
  }
}

function indexAdd<K, C>(index: Map<K, Set<C>>, key: K, stream: C): void {
  const set = index.get(key);
  if (set) set.add(stream);
  else index.set(key, new Set([stream]));
}

function indexDelete<K, C>(index: Map<K, Set<C>>, key: K, stream: C): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(stream);
  if (set.size === 0) index.delete(key);
}

/** A running bucket ticker. */
export interface BucketTicker {
  /** Stops the ticker; no bucket is visited afterwards. */
  stop(): void;
}

/**
 * Visits one heartbeat bucket per interval, round and round (`0, 1, …, buckets - 1, 0, …`).
 *
 * Why: decision 037: one hub timer for every stream (a timer per connection costs memory and wake-ups at 5000 streams); with 15
 * buckets and a 1 s tick each stream is visited every 15 s. The timers are injected (decision 031), so a test fires the ticks.
 *
 * @param timers the timers to schedule with
 * @param buckets how many buckets there are
 * @param intervalMs the time between two ticks
 * @param onBucket called with the index of the bucket of each tick; a throw is the caller's to handle and does not stop the ticker
 * @returns the ticker, to stop at shutdown
 */
export function startBucketTicker(
  timers: Timers,
  buckets: number,
  intervalMs: number,
  onBucket: (index: number) => void,
): BucketTicker {
  let tick = 0;
  let stopped = false;
  let handle: unknown;
  const schedule = () => {
    handle = timers.setTimeout(run, intervalMs);
  };
  function run(): void {
    if (stopped) return;
    const index = tick % buckets;
    tick += 1;
    try {
      onBucket(index);
    } finally {
      if (!stopped) schedule();
    }
  }
  schedule();
  return {
    stop: () => {
      stopped = true;
      timers.clearTimeout(handle);
    },
  };
}
