// The types of the real-time layer (decision 037): who watches a stream, the doorbell a change rings, the frames a source renders
// and the interface every source (the inbox here, support tickets in feature 28) implements. Exactly as the plan's § 3.2.

/**
 * The kinds of people a stream is opened for.
 *
 * Why: decision 037: one stream per signed-in browser and surface; `ticket` is the holder of a ticket link (feature 28), who has
 * no account and no default audience key.
 */
export type StreamViewerKind = 'staff' | 'client' | 'customer' | 'ticket';

/**
 * The person behind one open stream, as the guard authenticated them.
 *
 * Why: a source renders every event for the viewer with the viewer's rights (decision 037: nothing is trusted
 * from the doorbell); the hub keys connections by kind and id and closes them by session.
 */
export interface StreamViewer {
  readonly kind: StreamViewerKind;
  readonly id: number;
  /** The session that authenticated the stream; `null` for a `ticket` viewer. */
  readonly sessionId: number | null;
  /** The client address of the request (the per-address cap). */
  readonly ip: string;
  /** The display name of the account (the value of `{{name}}` in a broadcast). */
  readonly name: string;
  /** The staff member's permissions (a source may add keys for them); `[]` for every other kind. */
  readonly permissions: readonly string[];
}

/**
 * The message a change rings on the Redis channel: ids only, at most 8 KB.
 *
 * Why: decision 037 ("a doorbell, not data"): the API process that holds the connection re-reads Postgres with the viewer's
 * rights, so a lost or forged message loses or leaks nothing. Never a text, a token, an email address or a cookie.
 */
export interface Doorbell {
  readonly v: 1;
  /** The source that renders it (`inbox`), or `session` (handled by the hub itself). */
  readonly topic: string;
  /** What happened (`created`, `read`, `recount`; `ended`, `subject`). */
  readonly op: string;
  /** The publisher's clock in milliseconds (the delivery histogram). */
  readonly at: number;
  readonly [key: string]: unknown;
}

/**
 * One event a source wants written to a stream.
 *
 * Why: `data` is rendered once for every connection of a key, or per connection when it depends on the viewer (the `{{name}}` of an
 * inbox item); a frame with a `cursor` gets an `id:` line, so a reconnect can say what it saw.
 */
export interface Frame {
  /** The event name (`notification.created`). */
  readonly event: string;
  /** The JSON data, or a function that renders it for one viewer (it may throw: the frame is then logged and skipped). */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- the plan's exact interface (§ 3.2): the union says a function renders per viewer
  readonly data: unknown | ((viewer: StreamViewer) => unknown);
  /** The id of the source's row (`notification_inbox.id`), when the event can be replayed. */
  readonly cursor?: number;
}

/**
 * What a doorbell means for the open streams.
 *
 * Why: a source answers with the audience keys the event is for (`u:customer:42`), and either a frame to write or a reason to
 * end those streams (feature 28 ends the streams of a revoked ticket link).
 */
export interface Delivery {
  /** Audience keys: `u:<kind>:<id>` for an account, or a key a source added with `keysFor`. */
  readonly keys: readonly string[];
  readonly frame?: Frame;
  /** Send `bye` with this reason to the streams of the keys and end them. */
  readonly close?: 'session_ended' | 'reauth';
}

/**
 * A kind of live data (the inbox; feature 28 adds support tickets).
 *
 * Why: the hub knows nothing about tables: a source turns a doorbell into deliveries, replays what a reconnecting client missed
 * and sends a snapshot after the replay. Every query a source makes carries the viewer's own keys, so nothing of another person
 * can be rendered.
 */
export interface RealtimeSource {
  /** The doorbell topic this source renders (`inbox`). */
  readonly topic: string;
  /** One lower-case letter: this source's part of the composite cursor (`i` in `i9001-t5521`). */
  readonly cursorKey: string;
  /** Audience keys of a viewer beyond the default `u:<kind>:<id>`; may be `[]`. */
  keysFor(viewer: StreamViewer): readonly string[];
  /** The newest id now: where a stream without a cursor starts. */
  head(viewer: StreamViewer): Promise<number>;
  /** The viewer's frames after `after`, oldest first, at most `limit`; `'resync'` when more were missed (the client refetches). */
  replay(viewer: StreamViewer, after: number, limit: number): Promise<Frame[] | 'resync'>;
  /** Frames sent after `ready` and the replay (the unread count). */
  snapshot(viewer: StreamViewer): Promise<Frame[]>;
  /**
   * Turns a doorbell into deliveries.
   *
   * @param doorbell the parsed message of this source's topic
   * @param has whether any open stream has an audience key (resolve nothing nobody watches)
   */
  resolve(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]>;
}

/**
 * A limit on open streams: the newest stream over `max` is refused.
 *
 * Why: decision 037 caps streams per session (`session:91`, 3), per address (`ip:203.0.113.9`, 30) and, in feature 28, per
 * ticket link (`ticket:5`, 3); the first cap key is also the key of the `stream-connect` rate limiter.
 */
export interface CapKey {
  readonly key: string;
  readonly max: number;
}
