// defineEvent(): one frozen, registered contract per outgoing webhook event (decisions 008, 009, 017). The manifest
// key (`EVENT order.status_changed`) is the identity; the payload schema feeds the OpenAPI `webhooks` section.
import type { z } from 'zod';

/**
 * `EVENT <name>`, exactly as in `docs/route-manifest.json` (`EVENT order.status_changed`).
 *
 * Why: the key is the event's identity in the map, and the contract tests compare the registry with the manifest's
 * `EVENT ...` keys (decision 009).
 */
export type EventKey = `EVENT ${string}`;

const KEY_PATTERN = /^EVENT ([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/;

/**
 * The input of {@link defineEvent}.
 *
 * Why: the events merchants receive are part of the public contract (decision 017), so each one is described once, in
 * code, next to the route contracts, and the contract tests compare the registry with the manifest (decision 009).
 */
export interface EventSpec<P extends z.ZodType> {
  /** Manifest key, e.g. `EVENT order.status_changed`. */
  readonly key: EventKey;
  readonly summary: string;
  readonly description?: string;
  /** Schema of the `data` member of the delivery envelope `{ id, type, createdAt, data }`. */
  readonly payload: P;
  /** An example of `data`; validated against `payload`. */
  readonly example?: z.input<P>;
}

/**
 * The frozen contract of one outgoing event.
 *
 * Why: the OpenAPI builder and the contract tests read this shape, never the spec the author wrote.
 */
export interface EventContract<P extends z.ZodType = z.ZodType> {
  readonly key: EventKey;
  /** The event type sent in the envelope: `order.status_changed`. */
  readonly name: string;
  readonly summary: string;
  readonly description: string | undefined;
  readonly payload: P;
  readonly example: unknown;
}

/**
 * A list of event contracts, keyed by manifest key.
 *
 * Why: the OpenAPI documents and the contract tests (decision 009) read the registry instead of scanning modules.
 */
export class EventRegistry {
  private readonly events = new Map<EventKey, EventContract>();

  /**
   * Adds an event contract.
   *
   * @param contract the frozen contract
   * @throws {Error} when the key is already registered
   */
  register(contract: EventContract): void {
    if (this.events.has(contract.key)) throw new Error(`Event contract "${contract.key}" is defined twice`);
    this.events.set(contract.key, contract);
  }

  /**
   * Looks an event up by its manifest key.
   *
   * @param key a manifest key such as `EVENT invoice.paid`
   * @returns the contract, or `undefined` when none is registered
   */
  get(key: string): EventContract | undefined {
    return this.events.get(key as EventKey);
  }

  /**
   * Tells whether a manifest key has an event contract.
   *
   * @param key a manifest key such as `EVENT invoice.paid`
   * @returns true when the key is registered
   */
  has(key: string): boolean {
    return this.events.has(key as EventKey);
  }

  /**
   * Lists every event contract.
   *
   * @returns the contracts in definition order
   */
  all(): readonly EventContract[] {
    return [...this.events.values()];
  }

  /**
   * Lists every registered manifest key.
   *
   * @returns the keys in definition order
   */
  keys(): readonly EventKey[] {
    return [...this.events.keys()];
  }

  /** Removes every contract. Tests only: the default registry is process-wide. */
  clear(): void {
    this.events.clear();
  }
}

/**
 * The process-wide registry of outgoing events.
 *
 * Why: the public OpenAPI document lists these as `webhooks` (decision 017) and decision 009's route-parity test
 * compares them with the `EVENT …` keys of the manifest.
 */
export const eventRegistry = new EventRegistry();

/**
 * Defines, checks and registers the contract of one outgoing event.
 *
 * Why: merchants build their receivers from the documented payloads, so a mistake (a bad key, an example that fails its
 * own schema) must fail at boot, not in a merchant's integration.
 *
 * @param spec the event description
 * @param registry where to register it; tests pass their own, production code uses the default
 * @returns the frozen contract
 * @throws {Error} when the key is malformed, the summary is empty, the example fails the payload schema or the key
 *   was already defined (programming errors)
 *
 * @example
 * ```ts
 * export const orderStatusChanged = defineEvent({
 *   key: 'EVENT order.status_changed',
 *   summary: 'An order changed status',
 *   payload: z.object({ orderId: zId, status: z.string() }),
 *   example: { orderId: 42, status: 'completed' },
 * });
 * ```
 */
export function defineEvent<P extends z.ZodType>(
  spec: EventSpec<P>,
  registry: EventRegistry = eventRegistry,
): EventContract<P> {
  const where = `defineEvent("${spec.key}")`;
  const problem = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  const match = KEY_PATTERN.exec(spec.key);
  if (!match) return problem('the key must look like "EVENT order.status_changed"');
  if (spec.summary.trim() === '' || spec.summary.length > 120) problem('summary must be 1-120 characters');
  if (spec.example !== undefined && !spec.payload.safeParse(spec.example).success) {
    problem('example does not satisfy the payload schema');
  }
  const contract: EventContract<P> = Object.freeze({
    key: spec.key,
    name: match[1] ?? '',
    summary: spec.summary,
    description: spec.description,
    payload: spec.payload,
    example: spec.example,
  });
  registry.register(contract);
  return contract;
}
