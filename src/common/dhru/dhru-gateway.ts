// DhruGateway: the one adapter between the Dhru transport route and the modules that own the actions (decision 026). A module binds a
// handler to each action contract it owns; the gateway reads the `action` and the base64 `parameters`, validates them, runs the
// handler and builds the SUCCESS or ERROR envelope (bulk actions answer per item).
import { Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { MetricsService } from '../../infra/metrics/metrics.service';
import { FORBIDDEN_TEXT_DHRU_MESSAGE, forbiddenTextPathOf } from '../contract/forbidden-characters';
import { AppError } from '../errors';
import { dhruMessageOf } from '../errors/dhru-formatter';
import type { UploadedFile } from '../multipart';
import { type DhruItemAnswer, dhruBulk, dhruError, dhruSuccess, readParameters } from './dhru-envelope';
import type { AnyDhruAction, DhruActionContract } from './define-dhru-action';

/** The most items one bulk call may hold (the same limit as the portal's bulk order). */
export const DHRU_MAX_BULK_ITEMS = 100;

/**
 * The longest id a bulk item may have.
 *
 * Why: decision 053. The id is echoed in the answer and written to the log for every refused item, so its length is bounded.
 */
export const DHRU_MAX_ITEM_ID_LENGTH = 64;

/**
 * The action that places many orders in one call.
 *
 * Why: decision 053. The API key limiter charges this action one point per item (see `bulkPlacementItems`).
 */
export const DHRU_BULK_PLACEMENT_ACTION = 'placeimeiorderbulk';

/**
 * Counts the items a Dhru request would place, without running anything.
 *
 * Why: decision 053. A bulk placement costs one point of the key's per-minute limit per item, so the limiter needs the count before
 * the gateway runs. The gateway itself refuses what cannot be read, so an unreadable body counts as one point.
 *
 * @param body the parsed request body (form or JSON fields of `/api/index.php`)
 * @returns the number of item ids of a `placeimeiorderbulk` call (the `apiversion` key is not an item); 1 for every other call
 *   and for parameters that cannot be read
 */
export function bulkPlacementItems(body: unknown): number {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 1;
  const fields = body as Record<string, unknown>;
  if (typeof fields['action'] !== 'string' || fields['action'].trim().toLowerCase() !== DHRU_BULK_PLACEMENT_ACTION)
    return 1;
  try {
    return Object.keys(readParameters(fields['parameters'])).filter((key) => key !== 'apiversion').length;
  } catch {
    return 1;
  }
}

/** Who a Dhru call acts for: the merchant behind the API key. */
export interface DhruCaller {
  readonly clientId: number;
  readonly clientName: string;
  /** The API key that placed the call (stored on the orders it places). */
  readonly keyId: number;
}

/** What a handler receives. */
export interface DhruCall<P> {
  readonly caller: DhruCaller;
  /** The validated decoded parameters (one entry of a bulk call); `undefined` for an action without any. */
  readonly params: P;
  /** The files of a multipart call, in the order they were sent. */
  readonly files: readonly UploadedFile[];
  /** The caller's request id of a bulk item; `null` for a single action. */
  readonly itemId: string | null;
}

/** A handler bound to an action. */
export type DhruHandler<P, R> = (call: DhruCall<P>) => Promise<R> | R;

/** What the transport route asks the gateway to run. */
export interface DhruExecution {
  /** The `action` field as sent. */
  readonly action: string;
  /** The `parameters` field as sent (base64 text, an object, or nothing). */
  readonly parameters: unknown;
  readonly files: readonly UploadedFile[];
  readonly caller: DhruCaller;
}

interface Bound {
  readonly contract: AnyDhruAction;
  readonly handler: DhruHandler<unknown, unknown>;
}

/** Writes the first problem of a failed validation as the message a Dhru client shows. */
function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid parameters';
  const path = issue.path.map(String).join('.');
  return path === '' ? `Invalid parameters: ${issue.message}` : `${path}: ${issue.message}`;
}

/**
 * Runs the actions of the Dhru surface.
 *
 * Why: decision 026 puts eight actions on one endpoint and says every answer is HTTP 200 with a SUCCESS or ERROR list. The
 * modules that own the actions (money: `accountinfo`; catalog: `imeiservicelist`; orders: the rest) bind a handler each, so none of
 * them knows about the envelope; the transport route (orders) asks {@link DhruGateway.execute}. A single action that fails throws its
 * `AppError`, which the Dhru error formatter turns into the ERROR envelope; a bulk item that fails is answered inside the bulk body,
 * counted in `api_errors_total` under its catalog code and logged, because no exception reaches the filter for it.
 *
 * Side effects: whatever the handlers do; metrics and a log line per failed bulk item.
 */
@Injectable()
export class DhruGateway {
  private readonly logger = new Logger(DhruGateway.name);
  private readonly handlers = new Map<string, Bound>();

  constructor(private readonly metrics: MetricsService) {}

  /**
   * Binds the handler of an action.
   *
   * @param contract the action's contract (from `defineDhruAction`)
   * @param handler runs the action for one call (one item of a bulk call) and returns the success entry
   * @throws {Error} when the action already has a handler (two modules claiming one action is a programming error)
   */
  bind<P extends z.ZodType | undefined, S extends z.ZodType>(
    contract: DhruActionContract<P, S>,
    handler: DhruHandler<P extends z.ZodType ? z.output<P> : undefined, z.input<S>>,
  ): void {
    if (this.handlers.has(contract.action)) throw new Error(`Dhru action "${contract.action}" already has a handler`);
    this.handlers.set(contract.action, { contract, handler: handler as DhruHandler<unknown, unknown> });
  }

  /**
   * Lists the actions that have a handler.
   *
   * @returns the action names
   */
  boundActions(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Runs one Dhru request.
   *
   * @param request the action, its parameters, the files and who calls
   * @returns the whole answer body (`{ SUCCESS: [...], apiversion }`, or the per-item body of a bulk action)
   * @throws {AppError} for a single action: `BAD_REQUEST` ("Invalid Action") for an action nobody owns, `VALIDATION_FAILED` for
   *   parameters that cannot be read or do not fit or whose decoded text holds U+0000 or an unpaired surrogate (decision 053), and whatever the
   *   handler throws;
   *   a bulk call throws only for a body that has no items, too many, an item id of 0 or more than 64 characters, or parameters
   *   that hold U+0000 or an unpaired surrogate
   */
  async execute(request: DhruExecution): Promise<Record<string, unknown>> {
    const name = request.action.trim().toLowerCase();
    const bound = this.handlers.get(name);
    if (!bound) throw new AppError('BAD_REQUEST', { detail: 'Invalid Action' });
    const raw = readParameters(request.parameters);
    // Decision 053: the decoded text never passed the validation guard, so the same character rule is applied here.
    if (forbiddenTextPathOf(raw) !== undefined) {
      throw new AppError('VALIDATION_FAILED', { detail: FORBIDDEN_TEXT_DHRU_MESSAGE });
    }
    if (!bound.contract.bulk) {
      return dhruSuccess(await this.runOne(bound, raw, request, null));
    }
    const ids = Object.keys(raw);
    if (ids.length === 0) throw new AppError('VALIDATION_FAILED', { detail: 'Send at least one item.' });
    if (ids.length > DHRU_MAX_BULK_ITEMS) {
      throw new AppError('VALIDATION_FAILED', { detail: `At most ${DHRU_MAX_BULK_ITEMS} items per call.` });
    }
    if (ids.some((id) => id.length < 1 || id.length > DHRU_MAX_ITEM_ID_LENGTH)) {
      throw new AppError('VALIDATION_FAILED', { detail: 'An item id must have 1 to 64 characters.' });
    }
    if (ids.includes('apiversion'))
      throw new AppError('VALIDATION_FAILED', { detail: 'apiversion is not a valid item id.' });
    const answers = new Map<string, DhruItemAnswer>();
    // One after the other: items of one call draw on one wallet, so their order is the caller's order.
    for (const id of ids) {
      try {
        answers.set(id, { SUCCESS: [await this.runOne(bound, raw[id], request, id)] });
      } catch (error) {
        answers.set(id, dhruError(this.messageOfItem(error, request, id)));
      }
    }
    return dhruBulk(answers);
  }

  /** Validates the parameters of one call (or bulk item), runs the handler and shapes its entry with the success schema. */
  private async runOne(
    bound: Bound,
    rawParams: unknown,
    request: DhruExecution,
    itemId: string | null,
  ): Promise<unknown> {
    const { contract } = bound;
    let params: unknown;
    if (contract.params) {
      const parsed = contract.params.safeParse(rawParams ?? {});
      if (!parsed.success) throw new AppError('VALIDATION_FAILED', { detail: validationMessage(parsed.error) });
      params = parsed.data;
    }
    const entry = await bound.handler({ caller: request.caller, params, files: request.files, itemId });
    const shaped = contract.success.safeParse(entry);
    if (!shaped.success) throw new AppError('RESPONSE_CONTRACT_VIOLATION', { cause: shaped.error });
    return shaped.data;
  }

  /** The message of a failed bulk item; the failure is counted under its catalog code and logged like any refusal. */
  private messageOfItem(error: unknown, request: DhruExecution, itemId: string): string {
    const known = error instanceof AppError ? error : undefined;
    const appError = known ?? new AppError('INTERNAL_ERROR', { cause: error });
    this.metrics.recordApiError({
      surface: 'dhru',
      method: 'POST',
      route: '/api/index.php',
      status: String(appError.status),
      code: appError.code,
    });
    if (known === undefined) {
      this.logger.error(
        `Dhru bulk item ${itemId} of ${request.action} failed unexpectedly for merchant ${request.caller.clientId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    } else {
      this.logger.log(`Dhru bulk item ${itemId} of ${request.action} refused: ${appError.code}`);
    }
    return dhruMessageOf(appError);
  }
}
