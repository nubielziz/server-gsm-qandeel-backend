// The supplier driver interface (decision 026) and its two drivers: Dhru Fusion, and the REST driver that answers a clear refusal until
// a REST supplier exists (resolution orders-suppliers-9: `rest` is accepted on a supplier so the console can store it, but cannot
// be called yet). A driver turns the four supplier actions into one HTTP call each and reads the answer; it never logs and never
// touches the database: the caller writes the `supplier_api_logs` row from the record every call returns.
import type { HttpRequestOptions, HttpResult } from '../../../infra/http';
import { HttpRequestError } from '../../../infra/http';
import type { SupplierCallOutcome } from '../db/schema';
import {
  DHRU_ACTIONS,
  type AccountInfo,
  type DhruAction,
  type RemoteService,
  type SupplierOrderStatus,
  dhruEndpoint,
  dhruRequestBody,
  parseDhruAnswer,
  readAccountInfo,
  readOrderStatus,
  readPlacedOrder,
  readServiceList,
  redactBody,
} from '../domain/dhru-protocol';

/** What a driver needs to reach one supplier. */
export interface DriverContext {
  readonly baseUrl: string;
  readonly username: string;
  /** The decrypted API key; it lives only for the call and is never stored or logged. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** The call policy of the environment (tests reach a local server over plain http). */
  readonly policy: Pick<HttpRequestOptions, 'allowPrivateNetwork' | 'httpsOnly' | 'lookup'>;
}

/** What one call leaves behind: the row of the supplier log, without its supplier and order. */
export interface CallRecord {
  readonly action: string;
  /** The request with credentials and IMEIs masked. */
  readonly request: Record<string, unknown>;
  /** The answer with secrets masked, or `null` when none arrived. */
  readonly response: Record<string, unknown> | null;
  /** `0` when the supplier gave no HTTP answer. */
  readonly httpStatus: number;
  /** The time waited, always measured. */
  readonly durationMs: number;
  /** The reason of a failure; empty when the call worked. */
  readonly error: string;
  readonly outcome: SupplierCallOutcome;
}

/** Why a call failed: the supplier said no (`refused`), gave nothing usable (`invalid`), did not answer in time (`timeout`), could not be reached (`network`), was never sent (`blocked`, `unsupported`, `config`). */
export type CallFailureKind = 'refused' | 'invalid' | 'timeout' | 'network' | 'blocked' | 'unsupported' | 'config';

/** The answer of a driver call. */
export type DriverCall<T> =
  | { readonly ok: true; readonly value: T; readonly record: CallRecord }
  | { readonly ok: false; readonly kind: CallFailureKind; readonly message: string; readonly record: CallRecord };

/** The order a supplier is asked to place. */
export interface PlaceOrderInput {
  /** The supplier's service id (`supplier_services.remote_id`). */
  readonly remoteServiceId: string;
  /** The main input (the IMEI, or the first required field); `null` when the order has none. */
  readonly input: string | null;
  readonly quantity: number;
  /** The custom field values by the supplier's field names. */
  readonly customFields: Readonly<Record<string, string>>;
}

/** A supplier connection driver. */
export interface SupplierDriver {
  /** Asks for our balance (`accountinfo`). */
  accountInfo(context: DriverContext): Promise<DriverCall<AccountInfo>>;
  /** Asks for the supplier's services (`imeiservicelist`). */
  serviceList(context: DriverContext): Promise<DriverCall<RemoteService[]>>;
  /** Places an order (`placeimeiorder`). */
  placeOrder(context: DriverContext, order: PlaceOrderInput): Promise<DriverCall<{ reference: string }>>;
  /** Asks for the status of an order (`getimeiorder`). */
  getOrder(context: DriverContext, reference: string): Promise<DriverCall<SupplierOrderStatus>>;
}

/** The one HTTP function a driver needs: `OutboundHttp.request` in the application, a stand-in in a unit test. */
export interface DriverHttp {
  request(options: HttpRequestOptions & { target: string; operation?: string }): Promise<HttpResult>;
}

function failure<T>(
  kind: CallFailureKind,
  message: string,
  record: Omit<CallRecord, 'error' | 'outcome'> & { outcome?: SupplierCallOutcome },
): DriverCall<T> {
  return {
    ok: false,
    kind,
    message,
    record: { ...record, error: message, outcome: record.outcome ?? (kind === 'timeout' ? 'timeout' : 'error') },
  };
}

/** The Dhru Fusion v6.1 driver. */
export class DhruDriver implements SupplierDriver {
  constructor(private readonly http: DriverHttp) {}

  /**
   * Asks for our balance with `accountinfo`.
   *
   * @param context the supplier's address and credentials
   * @returns the balance, or why the call failed, with the record for the log
   */
  accountInfo(context: DriverContext): Promise<DriverCall<AccountInfo>> {
    return this.call(context, DHRU_ACTIONS.accountInfo, undefined, (payload) => {
      const info = readAccountInfo(payload);
      return info.ok ? { ok: true, value: info.value } : info;
    });
  }

  /**
   * Asks for the supplier's services with `imeiservicelist`.
   *
   * @param context the supplier's address and credentials
   * @returns the services, or why the call failed, with the record for the log
   */
  serviceList(context: DriverContext): Promise<DriverCall<RemoteService[]>> {
    // A service list can be megabytes: the log keeps the count, not the list.
    return this.call(
      context,
      DHRU_ACTIONS.serviceList,
      undefined,
      (payload) => ({ ok: true, value: readServiceList(payload) }),
      (services) => ({ services: services.length }),
    );
  }

  /**
   * Places an order with `placeimeiorder` (the service id, the input, the quantity and the custom fields).
   *
   * @param context the supplier's address and credentials
   * @param order what to order
   * @returns the supplier's REFERENCEID, or why the call failed, with the record for the log
   */
  placeOrder(context: DriverContext, order: PlaceOrderInput): Promise<DriverCall<{ reference: string }>> {
    const parameters: Record<string, unknown> = {
      ID: order.remoteServiceId,
      ...(order.input === null ? {} : { IMEI: order.input }),
      QNT: order.quantity,
      ...(Object.keys(order.customFields).length === 0 ? {} : { CUSTOMFIELD: order.customFields }),
    };
    return this.call(context, DHRU_ACTIONS.placeOrder, parameters, (payload) => {
      const reference = readPlacedOrder(payload);
      return reference === undefined
        ? { ok: false, message: 'The supplier accepted the order but sent no REFERENCEID.' }
        : { ok: true, value: { reference } };
    });
  }

  /**
   * Asks for the status of an order with `getimeiorder`.
   *
   * @param context the supplier's address and credentials
   * @param reference the supplier's REFERENCEID
   * @returns the state and the CODE, or why the call failed, with the record for the log
   */
  getOrder(context: DriverContext, reference: string): Promise<DriverCall<SupplierOrderStatus>> {
    return this.call(context, DHRU_ACTIONS.getOrder, { ID: reference }, (payload) => {
      const status = readOrderStatus(payload);
      return status ? { ok: true, value: status } : { ok: false, message: 'The supplier answer has no known STATUS.' };
    });
  }

  /** One exchange: the request, the HTTP call, the reading of the answer and the record for the log. */
  private async call<T>(
    context: DriverContext,
    action: DhruAction,
    parameters: Record<string, unknown> | undefined,
    read: (payload: Record<string, unknown>) => { ok: true; value: T } | { ok: false; message: string },
    describe?: (value: T) => Record<string, unknown>,
  ): Promise<DriverCall<T>> {
    const request = redactBody({ action, ...(parameters === undefined ? {} : { parameters }) });
    const started = performance.now();
    let result: HttpResult;
    try {
      result = await this.http.request({
        url: dhruEndpoint(context.baseUrl),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: dhruRequestBody({
          username: context.username,
          apiKey: context.apiKey,
          action,
          ...(parameters === undefined
            ? {}
            : {
                parameters: {
                  ...parameters,
                  // Custom fields travel as base64 JSON inside the parameters (decision 026).
                  ...(parameters.CUSTOMFIELD === undefined
                    ? {}
                    : { CUSTOMFIELD: Buffer.from(JSON.stringify(parameters.CUSTOMFIELD), 'utf8').toString('base64') }),
                },
              }),
        }),
        timeoutMs: context.timeoutMs,
        target: 'supplier',
        operation: `dhru.${action}`,
        ...context.policy,
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const base = { action, request, response: null, httpStatus: 0, durationMs };
      if (error instanceof HttpRequestError) {
        if (error.kind === 'timeout') {
          return failure('timeout', `Timed out after ${context.timeoutMs} ms`, {
            ...base,
            durationMs: Math.max(durationMs, 1),
          });
        }
        if (error.kind === 'blocked') return failure('blocked', error.message, base);
        return failure('network', error.kind === 'network' ? 'Connection failed' : error.message, base);
      }
      throw error;
    }
    const durationMs = Math.round(result.durationMs);
    if (result.status >= 300) {
      return failure('invalid', `The supplier answered HTTP ${result.status}.`, {
        action,
        request,
        response: null,
        httpStatus: result.status,
        durationMs,
      });
    }
    let json: unknown;
    try {
      json = result.json();
    } catch {
      return failure('invalid', 'The supplier answer is not JSON.', {
        action,
        request,
        response: null,
        httpStatus: result.status,
        durationMs,
      });
    }
    const answer = parseDhruAnswer(json);
    const base = {
      action,
      request,
      response: describe && answer.kind === 'success' ? null : redactBody(json),
      httpStatus: result.status,
      durationMs,
    };
    if (answer.kind === 'error') return failure('refused', answer.message, base);
    if (answer.kind === 'invalid') return failure('invalid', answer.message, base);
    const reading = read(answer.payload);
    if (!reading.ok) return failure('invalid', reading.message, base);
    const response = describe ? describe(reading.value) : base.response;
    return { ok: true, value: reading.value, record: { ...base, response, error: '', outcome: 'ok' } };
  }
}

/** The REST driver: stored on a supplier, refused on every call until a REST supplier exists. */
export class RestDriver implements SupplierDriver {
  /**
   * Refuses: no REST supplier is supported yet.
   *
   * @param context the supplier's address and credentials
   * @returns a failed call with a clear message
   */
  accountInfo(context: DriverContext): Promise<DriverCall<AccountInfo>> {
    return Promise.resolve(this.unsupported(DHRU_ACTIONS.accountInfo, context));
  }

  /**
   * Refuses: no REST supplier is supported yet.
   *
   * @param context the supplier's address and credentials
   * @returns a failed call with a clear message
   */
  serviceList(context: DriverContext): Promise<DriverCall<RemoteService[]>> {
    return Promise.resolve(this.unsupported(DHRU_ACTIONS.serviceList, context));
  }

  /**
   * Refuses: no REST supplier is supported yet.
   *
   * @param context the supplier's address and credentials
   * @returns a failed call with a clear message
   */
  placeOrder(context: DriverContext): Promise<DriverCall<{ reference: string }>> {
    return Promise.resolve(this.unsupported(DHRU_ACTIONS.placeOrder, context));
  }

  /**
   * Refuses: no REST supplier is supported yet.
   *
   * @param context the supplier's address and credentials
   * @returns a failed call with a clear message
   */
  getOrder(context: DriverContext): Promise<DriverCall<SupplierOrderStatus>> {
    return Promise.resolve(this.unsupported(DHRU_ACTIONS.getOrder, context));
  }

  private unsupported<T>(action: string, _context: DriverContext): DriverCall<T> {
    return failure('unsupported', 'REST suppliers are not supported yet: use the Dhru driver.', {
      action,
      request: { action },
      response: null,
      httpStatus: 0,
      durationMs: 0,
    });
  }
}
