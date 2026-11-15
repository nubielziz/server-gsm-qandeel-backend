// The wire format of a live stream (decision 037, server-sent events) and the writer that puts frames on one hijacked response:
// every frame is `[id: <cursor>]`, `event: <name>`, one `data:` line of JSON and a blank line; a client that does not read is
// dropped, never buffered.

/** The largest frame written; a longer one is a programming error (logged, counted and skipped). */
export const MAX_FRAME_BYTES = 32 * 1024;
/** What may wait in the response buffer beyond the current burst before the client counts as not reading. */
export const MAX_BUFFERED_BYTES = 262_144;

/**
 * The headers of a stream, beside the ones already on the reply (CORS, security, request id).
 *
 * Why: `no-transform` is load-bearing: a Next rewrite and Caddy compress or buffer a stream without it (plan fact 10);
 * `X-Accel-Buffering: no` tells an nginx in front not to buffer.
 */
export const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
});

const EVENT_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const CURSOR_TEXT = /^[a-z0-9-]{1,64}$/;

/**
 * The JSON of a frame's data, on one line.
 *
 * Why: an SSE `data:` line ends at a line break; `JSON.stringify` escapes every line break inside strings, so one line always
 * holds the whole value.
 *
 * @param data the value to send
 * @returns the JSON text
 * @throws {TypeError} when the value has no JSON form (`undefined`, a function) or cannot be serialised (a cycle, a BigInt)
 */
export function frameData(data: unknown): string {
  const json = JSON.stringify(data) as string | undefined;
  if (json === undefined) throw new TypeError('The frame data has no JSON form');
  return json;
}

/**
 * The text of one frame.
 *
 * Why: the browser's `EventSource` dispatches `event` with `data`, and remembers `id` for its reconnect (`Last-Event-ID`).
 *
 * @param event the event name (lower case, dots: `notification.created`)
 * @param json the data as one line of JSON ({@link frameData})
 * @param id the composite cursor after this frame, only for a replayable frame
 * @returns the frame, ending in a blank line
 * @throws {Error} for an event name or cursor that could break the framing (a programming error)
 */
export function frameText(event: string, json: string, id?: string): string {
  if (!EVENT_NAME.test(event)) throw new Error(`"${event}" is not a stream event name`);
  if (id !== undefined && !CURSOR_TEXT.test(id)) throw new Error(`"${id}" is not a stream cursor`);
  if (json.includes('\n') || json.includes('\r')) throw new Error('Frame data must be one line');
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${json}\n\n`;
}

/**
 * The `retry:` line that sets how long the browser waits before it reconnects by itself.
 *
 * Why: a random 2 to 5 seconds per stream spreads the reconnects after an API restart.
 *
 * @param ms the delay in milliseconds
 * @returns the field, ending in a blank line
 */
export function retryText(ms: number): string {
  return `retry: ${Math.max(0, Math.round(ms))}\n\n`;
}

/** The end of one write: written, the client does not read (`slow`), or the socket failed. */
export type WriteOutcome = 'ok' | 'slow' | 'error';

/** The part of a hijacked `ServerResponse` the writer uses. */
export interface StreamSink {
  write(chunk: string): boolean;
  readonly writableLength: number;
}

/**
 * Writes frames to one stream and notices a client that does not read.
 *
 * Why: decision 037: nothing is queued in the application. Bun holds what one synchronous burst wrote in the response until the
 * burst ends (a replay writes up to 100 frames at once), so the writer counts the bytes of the current burst and compares only
 * what is still queued beyond them with {@link MAX_BUFFERED_BYTES}: that is what a slow reader left behind.
 */
export class StreamWriter {
  private burst = 0;
  /** Bytes written so far. */
  bytes = 0;

  /**
   * @param sink the hijacked response
   * @param endOfBurst schedules the reset of the burst count after the current task (default `setImmediate`)
   */
  constructor(
    private readonly sink: StreamSink,
    private readonly endOfBurst: (fn: () => void) => void = (fn) => void setImmediate(fn),
  ) {}

  /**
   * Writes one piece of the stream.
   *
   * @param text a frame or a `retry:` line
   * @returns `ok`, `slow` when the client left more than {@link MAX_BUFFERED_BYTES} unread, `error` when the write threw
   */
  write(text: string): WriteOutcome {
    const size = Buffer.byteLength(text);
    if (this.burst === 0) this.endOfBurst(() => (this.burst = 0));
    this.burst += size;
    try {
      this.sink.write(text);
    } catch {
      return 'error';
    }
    this.bytes += size;
    return this.sink.writableLength - this.burst > MAX_BUFFERED_BYTES ? 'slow' : 'ok';
  }
}
