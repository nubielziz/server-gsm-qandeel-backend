// defineDhruAction(): the contract of one Dhru action (decision 026, 008). The map lists the eight actions as `DHRU <action>` keys; each
// has the zod schema of its decoded `parameters` and of the entry of its SUCCESS list, so the wire spelling (`AccoutInfo`, `REFERENCEID`,
// `STATUS` + `CODE`) is written once, checked by the fixtures and shown in the documentation.
import type { z } from 'zod';
import { type ErrorCode, isErrorCode } from '../errors/catalog';

/** `DHRU <action>`, exactly as in `docs/route-manifest.json`. */
export type DhruActionKey = `DHRU ${string}`;

/** What {@link defineDhruAction} takes. */
export interface DhruActionSpec<P extends z.ZodType | undefined, S extends z.ZodType> {
  /** Manifest key, `DHRU placeimeiorder`. */
  readonly key: DhruActionKey;
  readonly summary: string;
  readonly description?: string;
  /**
   * `true` for the bulk actions: `parameters` is an object keyed by the caller's request id and every entry is validated, run and
   * answered on its own (`params` and `success` describe one entry).
   */
  readonly bulk?: boolean;
  /** The decoded `parameters` (one entry for a bulk action); omit for an action that takes none. */
  readonly params?: P;
  /** The entry of the SUCCESS list. */
  readonly success: S;
  /** Catalog codes the action can answer with (each becomes an ERROR message). */
  readonly errors: readonly ErrorCode[];
  /** An example of the decoded parameters (one entry for a bulk action) and of the success entry; both are validated. */
  readonly examples?: { readonly request?: unknown; readonly response?: unknown };
}

/** The frozen contract of one Dhru action. */
export interface DhruActionContract<
  P extends z.ZodType | undefined = z.ZodType | undefined,
  S extends z.ZodType = z.ZodType,
> {
  readonly key: DhruActionKey;
  /** The value of the `action` field: `placeimeiorder`. */
  readonly action: string;
  readonly summary: string;
  readonly description: string | undefined;
  readonly bulk: boolean;
  readonly params: P;
  readonly success: S;
  readonly errors: readonly ErrorCode[];
  readonly examples: { readonly request: unknown; readonly response: unknown };
}

/** A Dhru action contract whose schemas are not known statically. */
export type AnyDhruAction = DhruActionContract<z.ZodType | undefined, z.ZodType>;

/** The validated decoded parameters a handler receives (`undefined` for an action without any). */
export type DhruParamsOf<C extends AnyDhruAction> = C['params'] extends z.ZodType ? z.output<C['params']> : undefined;
/** What a handler returns: the success entry before the schema strips it. */
export type DhruResultOf<C extends AnyDhruAction> = z.input<C['success']>;

/**
 * The process-wide list of Dhru action contracts.
 *
 * Why: the contract tests compare it with the manifest's `DHRU` keys (decision 009) and the OpenAPI description reads it.
 */
export class DhruActionRegistry {
  private readonly actions = new Map<string, AnyDhruAction>();

  /**
   * Adds a contract.
   *
   * @param contract the frozen contract
   * @throws {Error} when the action is already defined
   */
  register(contract: AnyDhruAction): void {
    if (this.actions.has(contract.action)) throw new Error(`Dhru action "${contract.action}" is defined twice`);
    this.actions.set(contract.action, contract);
  }

  /**
   * Looks a contract up by the value of the `action` field.
   *
   * @param action the action, lower case
   * @returns the contract, or `undefined`
   */
  get(action: string): AnyDhruAction | undefined {
    return this.actions.get(action);
  }

  /**
   * Lists the contracts.
   *
   * @returns every contract, in definition order
   */
  all(): readonly AnyDhruAction[] {
    return [...this.actions.values()];
  }

  /** Removes every contract. Tests only. */
  clear(): void {
    this.actions.clear();
  }
}

/** The global registry of Dhru actions. */
export const dhruActionRegistry = new DhruActionRegistry();

/**
 * Defines, checks and registers one Dhru action.
 *
 * Why: decision 026 gives the wire of each action; one definition per action keeps its parameters, its success entry and its
 * examples together, and a mistake (an example that fails its schema, an unknown error code) fails at boot.
 *
 * @param spec the action
 * @returns the frozen contract, also stored in {@link dhruActionRegistry}
 * @throws {Error} when the definition is inconsistent
 */
export function defineDhruAction<P extends z.ZodType | undefined = undefined, S extends z.ZodType = z.ZodType>(
  spec: DhruActionSpec<P, S>,
): DhruActionContract<P, S> {
  const where = `defineDhruAction("${spec.key}")`;
  const problem = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  const match = /^DHRU ([a-z]+)$/.exec(spec.key);
  if (!match) problem('the key must look like "DHRU placeimeiorder"');
  if (spec.summary.trim() === '' || spec.summary.length > 120) problem('summary must be 1-120 characters');
  for (const code of spec.errors) {
    if (!isErrorCode(code)) problem(`unknown error code "${String(code)}"`);
  }
  const examples = spec.examples ?? {};
  if (examples.request !== undefined) {
    if (!spec.params) problem('examples.request needs a params schema');
    else if (!spec.params.safeParse(examples.request).success)
      problem('examples.request does not satisfy the params schema');
  }
  if (examples.response !== undefined && !spec.success.safeParse(examples.response).success) {
    problem('examples.response does not satisfy the success schema');
  }
  const contract: DhruActionContract<P, S> = Object.freeze({
    key: spec.key,
    action: match![1]!,
    summary: spec.summary,
    description: spec.description,
    bulk: spec.bulk ?? false,
    params: spec.params as P,
    success: spec.success,
    errors: Object.freeze([...spec.errors]),
    examples: Object.freeze({ request: examples.request, response: examples.response }),
  });
  dhruActionRegistry.register(contract);
  return contract;
}
