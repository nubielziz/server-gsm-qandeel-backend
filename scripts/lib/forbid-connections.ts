// Guard for the offline scripts (gen-openapi.ts): any attempt to open a network socket is recorded and refused.
// It turns "constructors never connect" (P2.3 Postgres pool, P2.4 Redis clients) into a check CI can fail on.
import net from 'node:net';

/**
 * Refuses every `net`/`tls` socket connection from now on and records each attempt.
 *
 * Why: the OpenAPI generator builds the whole Nest application without `init()`; if a provider opens a connection in
 * its constructor the generator would need Postgres or Redis. Clients such as ioredis swallow the thrown error into an
 * `error` event, so the attempts are collected for the caller to fail on. ioredis (and BullMQ) opens its socket on
 * `process.nextTick`, after the constructor returned, so read the array only after one turn of the event loop
 * (`createOfflineApp` does). Covers `node:net` and `node:tls` (pg, ioredis, the AWS SDK); `Bun.connect` and `fetch`
 * are not used by those libraries.
 *
 * @returns the attempts, as text; the array grows as attempts happen, some a tick after the code that caused them
 */
export function forbidConnections(): readonly string[] {
  const attempts: string[] = [];
  net.Socket.prototype.connect = function connectIsForbidden(...args: unknown[]): never {
    const target = JSON.stringify(args[0] ?? null);
    attempts.push(target.length > 120 ? `${target.slice(0, 117)}...` : target);
    throw new Error('Offline script: opening a network connection is not allowed (constructors must not connect).');
  };
  return attempts;
}
