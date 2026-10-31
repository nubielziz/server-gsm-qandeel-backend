// Per-request context (decisions 012, 018): the request id, who is acting and how many audit rows the request wrote.
// One AsyncLocalStorage, so services read it (AuditService, the outbox writer, the logger) without passing the request around.
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The authenticated caller of the current request, as the session guards record it.
 *
 * Why: the audit log needs the actor of a write (decision 018: "actor and ip from the request context") and the
 * services that write it do not receive the HTTP request. `src/common` cannot import the identity module, so this is the
 * small shape both sides agree on; the full principal stays in the identity module.
 */
export interface RequestActor {
  readonly type: 'staff' | 'client' | 'customer';
  readonly id: number;
}

/**
 * What is known about the request being handled.
 *
 * Why: see {@link RequestActor}. The object is created when the request starts and mutated by the guards (`actor`, `ip`)
 * and by the audit service (`auditRecords`), so everything that runs later in the same request sees it.
 */
export interface RequestContext {
  readonly requestId: string;
  /** Set by the session guards once the caller is authenticated; `undefined` for public routes and for jobs. */
  actor: RequestActor | undefined;
  /** The client IP the guards judged (`request.ip` behind the trusted proxy chain). */
  ip: string | undefined;
  /** How many `audit_logs` rows the request wrote; the audit enforcement reads it after the handler. */
  auditRecords: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with a fresh context for `requestId` (everything `fn` starts sees it: awaits, timers, callbacks).
 *
 * Why: the request hook and the queue worker start one context per request or job; nested calls get their own.
 *
 * @param requestId the id to bind
 * @param fn the work to run
 * @returns what `fn` returns
 */
export function runInRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId, actor: undefined, ip: undefined, auditRecords: 0 }, fn);
}

/**
 * Returns the context of the request being handled.
 *
 * Why: services that need the actor, the IP or the audit counter read it here.
 *
 * @returns the context, or `undefined` outside a request (boot, scheduled work without a parent)
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Records who is acting in the current request.
 *
 * Why: the session guards call it once the caller is authenticated; the audit service reads it. Outside a request it does
 * nothing (a unit test of a guard has no context).
 *
 * Side effects: mutates the current request context.
 *
 * @param actor the authenticated caller
 * @param ip the client IP of the request
 */
export function setRequestActor(actor: RequestActor, ip: string): void {
  const context = storage.getStore();
  if (!context) return;
  context.actor = actor;
  context.ip = ip;
}

/**
 * Counts one audit row written by the current request.
 *
 * Why: the audit enforcement fails (or logs) a staff write that wrote none; `AuditService.record` calls this after its
 * insert succeeded.
 *
 * Side effects: mutates the current request context.
 */
export function countAuditRecord(): void {
  const context = storage.getStore();
  if (context) context.auditRecords += 1;
}
