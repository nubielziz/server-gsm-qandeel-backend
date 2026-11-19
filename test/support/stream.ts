// A test client for the live event streams (decision 037): opens a stream on a listening test app over a plain TCP socket (HTTP/1.1,
// chunked), parses the server-sent events into frames and lets a test wait for them, stop reading (a slow client) or hang up.
import net from 'node:net';
import { CacheKeys } from '@src/infra/cache';
import { RedisService } from '@src/infra/redis';
import type { TestApp } from './app';

/** One server-sent event as the browser's `EventSource` would dispatch it. */
export interface StreamFrame {
  /** The `id:` line (the composite cursor), when the frame had one. */
  readonly id: string | undefined;
  readonly event: string;
  /** The `data:` line, parsed as JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test data is untyped JSON: assertions read it freely
  readonly data: any;
}

/** An opened (or refused) stream. */
export interface TestStream {
  readonly status: number;
  /** Response headers, lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed problem+json body of a refusal (`undefined` for a stream). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test data is untyped JSON
  readonly body: any;
  /** Every frame so far, in order. */
  readonly frames: readonly StreamFrame[];
  /** The `retry:` value the server sent, if any. */
  readonly retryMs: number | undefined;
  /** Resolves when the server ended the response or the socket closed. */
  readonly ended: Promise<void>;
  /** True once {@link ended} resolved. */
  readonly isEnded: boolean;
  /**
   * Waits for the next frame not taken yet (of one event, when named) and takes it.
   *
   * @param event the event name to wait for; frames of other events before it are skipped (and stay taken)
   * @param timeoutMs how long to wait before failing
   */
  next(event?: string, timeoutMs?: number): Promise<StreamFrame>;
  /** The frames not taken yet. */
  rest(): StreamFrame[];
  /** Stops reading from the socket (a client that does not read). */
  pause(): void;
  /** Hangs up (the browser closed the tab). */
  close(): void;
}

/** The headers a browser sends with a same-origin `EventSource` request: no `Origin`, `Sec-Fetch-Site: same-origin`. */
export const SAME_ORIGIN: Readonly<Record<string, string>> = Object.freeze({
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  accept: 'text/event-stream',
});

/**
 * Makes the test app listen on a free local port (streams need a real socket; `inject` waits for the end of the response).
 *
 * @param t the test app
 * @returns the base URL, `http://127.0.0.1:<port>`
 */
export async function listen(t: TestApp): Promise<string> {
  await t.app.listen(0, '127.0.0.1');
  const address = t.app.getHttpServer().address() as net.AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Deletes the counters of the `stream-connect` limiter.
 *
 * Why: its key is the session id (`session:1`), which starts at 1 again after every `resetDb`; the counters live a minute in the
 * cache Redis, so the tests of one file would share one budget of 20 opens.
 *
 * @param t the test app
 */
export async function clearStreamLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const found = await redis.keys(`${t.app.get(CacheKeys).rateLimit('stream-connect')}:*`);
  if (found.length > 0) await redis.del(...found);
}

/**
 * Opens a stream.
 *
 * @param url the full URL (`http://127.0.0.1:1234/store/v1/me/stream`)
 * @param headers the request headers (the session cookie, `last-event-id`, the `Sec-Fetch-*` headers)
 * @param timeoutMs how long to wait for the response head
 * @returns the stream once its head arrived (for a refusal, once its body arrived)
 */
export function openStream(url: string, headers: Record<string, string> = {}, timeoutMs = 5000): Promise<TestStream> {
  const target = new URL(url);
  const socket = net.connect(Number(target.port), target.hostname);
  const frames: StreamFrame[] = [];
  const waiters = new Set<() => void>();
  let taken = 0;
  let raw = Buffer.alloc(0);
  let head: { status: number; headers: Record<string, string> } | undefined;
  let chunked = false;
  let bodyLength: number | undefined;
  let body = Buffer.alloc(0);
  let text = '';
  let retryMs: number | undefined;
  let isEnded = false;
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  const finish = () => {
    if (isEnded) return;
    isEnded = true;
    resolveEnded();
    for (const wake of waiters) wake();
  };

  const parseEvents = () => {
    for (;;) {
      const end = text.indexOf('\n\n');
      if (end < 0) return;
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      let id: string | undefined;
      let event: string | undefined;
      let data: string | undefined;
      for (const line of block.split('\n')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') id = value;
        else if (field === 'event') event = value;
        else if (field === 'data') data = data === undefined ? value : `${data}\n${value}`;
        else if (field === 'retry') retryMs = Number(value);
      }
      if (data === undefined) continue;
      frames.push({ id, event: event ?? 'message', data: JSON.parse(data) });
    }
  };

  const onBody = (bytes: Buffer) => {
    if (head?.status === 200) {
      text += bytes.toString('utf8');
      parseEvents();
      for (const wake of waiters) wake();
    } else body = Buffer.concat([body, bytes]);
  };

  /** Decodes as much of the chunked (or plain) body as has arrived. */
  const drain = () => {
    for (;;) {
      if (!chunked) {
        if (raw.length > 0) {
          onBody(raw);
          raw = Buffer.alloc(0);
        }
        if (bodyLength !== undefined && body.length >= bodyLength) finish();
        return;
      }
      const lineEnd = raw.indexOf('\r\n');
      if (lineEnd < 0) return;
      const size = Number.parseInt(raw.subarray(0, lineEnd).toString('ascii'), 16);
      if (size === 0) {
        finish();
        return;
      }
      if (raw.length < lineEnd + 2 + size + 2) return;
      onBody(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
      raw = raw.subarray(lineEnd + 2 + size + 2);
    }
  };

  return new Promise<TestStream>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No response from ${url} within ${timeoutMs} ms`));
    }, timeoutMs);
    const stream = (): TestStream => ({
      status: head!.status,
      headers: head!.headers,
      body: head!.status === 200 || body.length === 0 ? undefined : JSON.parse(body.toString('utf8')),
      get frames() {
        return frames;
      },
      get retryMs() {
        return retryMs;
      },
      ended,
      get isEnded() {
        return isEnded;
      },
      next: (event, wait = 5000) =>
        new Promise<StreamFrame>((found, fail) => {
          const look = () => {
            while (taken < frames.length) {
              const frame = frames[taken++]!;
              if (event === undefined || frame.event === event) {
                done();
                found(frame);
                return;
              }
            }
            if (isEnded) {
              done();
              fail(new Error(`The stream ended before a "${event ?? 'any'}" frame; saw ${describe(frames)}`));
            }
          };
          const deadline = setTimeout(() => {
            done();
            fail(new Error(`No "${event ?? 'any'}" frame within ${wait} ms; saw ${describe(frames)}`));
          }, wait);
          const done = () => {
            clearTimeout(deadline);
            waiters.delete(look);
          };
          waiters.add(look);
          look();
        }),
      rest: () => frames.slice(taken),
      pause: () => socket.pause(),
      close: () => socket.destroy(),
    });

    socket.on('connect', () => {
      const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      if (!head) {
        const end = raw.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [statusLine, ...headerLines] = raw.subarray(0, end).toString('latin1').split('\r\n');
        const parsed: Record<string, string> = {};
        for (const line of headerLines) {
          const colon = line.indexOf(':');
          parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        head = { status: Number(statusLine!.split(' ')[1]), headers: parsed };
        chunked = (parsed['transfer-encoding'] ?? '').includes('chunked');
        bodyLength = parsed['content-length'] === undefined ? undefined : Number(parsed['content-length']);
        raw = raw.subarray(end + 4);
        if (head.status === 200) {
          clearTimeout(timer);
          resolve(stream());
        }
      }
      drain();
      if (head && head.status !== 200 && isEnded) {
        clearTimeout(timer);
        resolve(stream());
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      finish();
      if (head && head.status !== 200) {
        clearTimeout(timer);
        resolve(stream());
      }
    });
  });
}

function describe(frames: readonly StreamFrame[]): string {
  return frames.length === 0 ? 'nothing' : frames.map((frame) => frame.event).join(', ');
}
