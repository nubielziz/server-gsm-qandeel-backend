// defineSupplierCall(): one frozen, registered contract per call this backend makes to a supplier's Dhru Fusion API (decisions 008, 009,
// 026). The manifest key (`SUPPLIER accountinfo`) is the identity; the schemas say what we send and which answer we accept.
import { z } from 'zod';

/**
 * `SUPPLIER <action>` or `SUPPLIER <action>+<action>bulk`, exactly as in `docs/route-manifest.json`.
 *
 * Why: the key is the call's identity in the map, and the contract tests compare the registry with the manifest's `SUPPLIER ...` keys
 * (decision 009).
 */
export type SupplierCallKey = `SUPPLIER ${string}`;

/** Group 1 is the action, group 2 the optional bulk variant that must be the action plus `bulk`. */
const KEY_PATTERN = /^SUPPLIER ([a-z]+)(?:\+([a-z]+))?$/;

/**
 * The entry of a Dhru `ERROR` list: the supplier's refusal.
 *
 * Why: decision 026: every refusal (a wrong credential, an unknown action, a rejected order) is `{ "ERROR": [ { "MESSAGE": "..." } ] }`
 * with HTTP 200. Every supplier call shares it, so it is written once.
 */
export const zSupplierError = z.looseObject({
  MESSAGE: z
    .string()
    .describe('Why the supplier refused, for example `Authentication Failed` or `Not enough credits`.'),
});

/**
 * The input of {@link defineSupplierCall}.
 *
 * Why: the calls we make to suppliers are part of the integration contract (decision 026), so each one is described once, in code, next
 * to the route contracts; the client reads the answer through the same schema, so the code cannot drift from the description.
 */
export interface SupplierCallSpec<P extends z.ZodType | undefined, S extends z.ZodType> {
  /** Manifest key: `SUPPLIER accountinfo`, or `SUPPLIER placeimeiorder+placeimeiorderbulk` when the call has a bulk variant. */
  readonly key: SupplierCallKey;
  readonly summary: string;
  /** Required when the key names a bulk variant: it must say whether the client sends it (the word "bulk" appears in it). */
  readonly description?: string;
  /** `true` when the client sends the bulk variant; `false` (the default) when it is described but never sent. */
  readonly sendsBulk?: boolean;
  /** The decoded `parameters` this backend sends (one entry for a bulk call); omit for a call that takes none. */
  readonly params?: P;
  /** The entry of the `SUCCESS` list this backend accepts; the client reads the answer through it. */
  readonly success: S;
  /** The entry of the `ERROR` list; defaults to {@link zSupplierError}. */
  readonly error?: z.ZodType;
  /** An example of the decoded parameters, of the success entry and of the error entry; each is validated against its schema. */
  readonly examples?: { readonly request?: unknown; readonly response?: unknown; readonly error?: unknown };
}

/**
 * The frozen contract of one supplier call.
 *
 * Why: the client, the OpenAPI builder and the contract tests read this shape, never the spec the author wrote.
 */
export interface SupplierCallContract<
  P extends z.ZodType | undefined = z.ZodType | undefined,
  S extends z.ZodType = z.ZodType,
> {
  readonly key: SupplierCallKey;
  /** The value of the `action` field the client sends: `placeimeiorder`. */
  readonly action: string;
  /** The bulk variant (`placeimeiorderbulk`), or `null` when the call has none. */
  readonly bulkAction: string | null;
  /** True when the client really sends the bulk variant. */
  readonly sendsBulk: boolean;
  readonly summary: string;
  readonly description: string | undefined;
  readonly params: P;
  readonly success: S;
  readonly error: z.ZodType;
  /**
   * The whole answer body: `{ SUCCESS: [entry, ...] }` or `{ ERROR: [entry, ...] }`; other members (`apiversion`) are ignored.
   * It is the documented shape, stricter than the client's reader (`parseDhruAnswer` also takes a bare `SUCCESS` object, a lower-case
   * `message`, a text `ERROR`, and reads an answer with both members as a refusal): tests and the OpenAPI listing use it, the client does not.
   */
  readonly answer: z.ZodType;
  readonly examples: { readonly request: unknown; readonly response: unknown; readonly error: unknown };
}

/** A supplier call contract whose schemas are not known statically. */
export type AnySupplierCall = SupplierCallContract<z.ZodType | undefined, z.ZodType>;

/** The decoded parameters the client sends for a call (`undefined` for a call without any). */
export type SupplierCallParamsOf<C extends AnySupplierCall> = C['params'] extends z.ZodType
  ? z.input<C['params']>
  : undefined;
/** The success entry as the client reads it, after the schema. */
export type SupplierCallEntryOf<C extends AnySupplierCall> = z.output<C['success']>;

/**
 * A list of supplier call contracts, keyed by manifest key.
 *
 * Why: the OpenAPI documents and the contract tests (decision 009) read the registry instead of scanning modules.
 */
export class SupplierCallRegistry {
  private readonly calls = new Map<SupplierCallKey, AnySupplierCall>();

  /**
   * Adds a contract.
   *
   * @param contract the frozen contract
   * @throws {Error} when the key, the action or the bulk action is already taken
   */
  register(contract: AnySupplierCall): void {
    if (this.calls.has(contract.key)) throw new Error(`Supplier call "${contract.key}" is defined twice`);
    for (const action of [contract.action, contract.bulkAction]) {
      if (action !== null && this.forAction(action))
        throw new Error(`Supplier call action "${action}" is defined twice`);
    }
    this.calls.set(contract.key, contract);
  }

  /**
   * Looks a contract up by its manifest key.
   *
   * @param key a manifest key such as `SUPPLIER accountinfo`
   * @returns the contract, or `undefined` when none is registered
   */
  get(key: string): AnySupplierCall | undefined {
    return this.calls.get(key as SupplierCallKey);
  }

  /**
   * Looks a contract up by the value of the `action` field, the bulk variant included.
   *
   * @param action `placeimeiorder` or `placeimeiorderbulk`
   * @returns the contract that describes the action, or `undefined`
   */
  forAction(action: string): AnySupplierCall | undefined {
    return [...this.calls.values()].find((call) => call.action === action || call.bulkAction === action);
  }

  /**
   * Tells whether a manifest key has a supplier call contract.
   *
   * @param key a manifest key such as `SUPPLIER accountinfo`
   * @returns true when the key is registered
   */
  has(key: string): boolean {
    return this.calls.has(key as SupplierCallKey);
  }

  /**
   * Lists every supplier call contract.
   *
   * @returns the contracts in definition order
   */
  all(): readonly AnySupplierCall[] {
    return [...this.calls.values()];
  }

  /**
   * Lists every registered manifest key.
   *
   * @returns the keys in definition order
   */
  keys(): readonly SupplierCallKey[] {
    return [...this.calls.keys()];
  }

  /** Removes every contract. Tests only: the default registry is process-wide. */
  clear(): void {
    this.calls.clear();
  }
}

/**
 * The process-wide registry of supplier calls.
 *
 * Why: decision 009's route-parity test compares it with the `SUPPLIER ...` keys of the manifest, and the internal OpenAPI document
 * lists it.
 */
export const supplierCallRegistry = new SupplierCallRegistry();

/**
 * Defines, checks and registers the contract of one supplier call.
 *
 * Why: the calls we make are written from decision 026 and from what the client really sends and reads. A mistake (a bad key, an
 * example that fails its own schema, a bulk variant nobody explained) must fail at boot, not in a supplier integration.
 *
 * @param spec the call description
 * @param registry where to register it; tests pass their own, production code uses the default
 * @returns the frozen contract
 * @throws {Error} when the key is malformed, the summary is empty or too long, a bulk variant has no description, `sendsBulk` is set on
 *   a call without a bulk variant, an example fails its schema, or the key was already defined (programming errors)
 *
 * @example
 * ```ts
 * export const accountInfoCall = defineSupplierCall({
 *   key: 'SUPPLIER accountinfo',
 *   summary: 'Our balance at the supplier',
 *   success: z.looseObject({ AccoutInfo: z.looseObject({ credit: z.string() }) }),
 *   examples: { response: { AccoutInfo: { credit: '12.5000' } } },
 * });
 * ```
 */
export function defineSupplierCall<P extends z.ZodType | undefined = undefined, S extends z.ZodType = z.ZodType>(
  spec: SupplierCallSpec<P, S>,
  registry: SupplierCallRegistry = supplierCallRegistry,
): SupplierCallContract<P, S> {
  const where = `defineSupplierCall("${spec.key}")`;
  const problem = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  const match = KEY_PATTERN.exec(spec.key);
  if (!match)
    return problem('the key must look like "SUPPLIER accountinfo" or "SUPPLIER placeimeiorder+placeimeiorderbulk"');
  const action = match[1] ?? '';
  const bulkAction = match[2] ?? null;
  if (bulkAction !== null && bulkAction !== `${action}bulk`)
    problem(`the bulk variant of "${action}" must be "${action}bulk"`);
  if (spec.summary.trim() === '' || spec.summary.length > 120) problem('summary must be 1-120 characters');
  if (bulkAction === null && spec.sendsBulk === true) problem('sendsBulk needs a bulk variant in the key');
  if (bulkAction !== null && !/bulk/i.test(spec.description ?? '')) {
    problem('a call with a bulk variant needs a description that says whether the client sends the bulk call');
  }
  const examples = spec.examples ?? {};
  const error = spec.error ?? zSupplierError;
  if (examples.request !== undefined) {
    if (!spec.params) problem('examples.request needs a params schema');
    else if (!spec.params.safeParse(examples.request).success)
      problem('examples.request does not satisfy the params schema');
  }
  if (examples.response !== undefined && !spec.success.safeParse(examples.response).success) {
    problem('examples.response does not satisfy the success schema');
  }
  if (examples.error !== undefined && !error.safeParse(examples.error).success) {
    problem('examples.error does not satisfy the error schema');
  }
  const contract: SupplierCallContract<P, S> = Object.freeze({
    key: spec.key,
    action,
    bulkAction,
    sendsBulk: spec.sendsBulk ?? false,
    summary: spec.summary,
    description: spec.description,
    params: spec.params as P,
    success: spec.success,
    error,
    answer: z.union([
      z.looseObject({ SUCCESS: z.array(spec.success).min(1) }),
      z.looseObject({ ERROR: z.array(error).min(1) }),
    ]),
    examples: Object.freeze({ request: examples.request, response: examples.response, error: examples.error }),
  });
  registry.register(contract);
  return contract;
}
