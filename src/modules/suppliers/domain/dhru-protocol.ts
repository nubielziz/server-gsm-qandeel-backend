// The Dhru Fusion v6.1 client side (decision 026): the request an outbound supplier call sends and how each answer is read. Pure,
// so the fake supplier of the tests and the real one are judged by the same code. Serves the supplier calls of stage 6; every answer is
// read through the schema of its contract (`contracts/supplier-calls.contracts.ts`).
import { Decimal } from 'decimal.js';
import { accountInfoCall, getOrderCall, placeOrderCall, serviceListCall } from '../contracts/supplier-calls.contracts';
import { amountText } from './amount-text';

export { amountText };

/** The four supplier actions this backend calls (`docs/slices/suppliers.json`, `SUPPLIER ...` rows). */
export const DHRU_ACTIONS = {
  accountInfo: 'accountinfo',
  serviceList: 'imeiservicelist',
  placeOrder: 'placeimeiorder',
  getOrder: 'getimeiorder',
} as const;

/** One value of {@link DHRU_ACTIONS}. */
export type DhruAction = (typeof DHRU_ACTIONS)[keyof typeof DHRU_ACTIONS];

/**
 * The address a supplier's Dhru API answers at.
 *
 * Why: suppliers are stored as `https://host` (the demo's rows), the standard's endpoint is `/api/index.php`; a base URL that
 * already names a `.php` file is used as it is.
 *
 * @param baseUrl the supplier's base URL
 * @returns the URL to post to
 */
export function dhruEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\.php$/i.test(trimmed) ? trimmed : `${trimmed}/api/index.php`;
}

/** What a call needs to build the request body. */
export interface DhruRequestInput {
  readonly username: string;
  readonly apiKey: string;
  readonly action: DhruAction;
  /** The action's parameters; sent as base64 of their JSON (decision 026). */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/**
 * Builds the form body of a Dhru call.
 *
 * Why: decision 026: `application/x-www-form-urlencoded` with `username`, `apiaccesskey`, `action`, `requestformat=JSON` and
 * `parameters` = base64 of a JSON object.
 *
 * @param input the credentials, the action and its parameters
 * @returns the body to post
 */
export function dhruRequestBody(input: DhruRequestInput): URLSearchParams {
  const body = new URLSearchParams({
    username: input.username,
    apiaccesskey: input.apiKey,
    action: input.action,
    requestformat: 'JSON',
  });
  if (input.parameters !== undefined) {
    body.set('parameters', Buffer.from(JSON.stringify(input.parameters), 'utf8').toString('base64'));
  }
  return body;
}

/** A Dhru answer reduced to its three possible meanings. */
export type DhruAnswer =
  | { readonly kind: 'success'; readonly payload: Record<string, unknown> }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstOf(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/**
 * Reads a Dhru answer body.
 *
 * Why: decision 026: `{ "SUCCESS": [ ... ] }` or `{ "ERROR": [ { "MESSAGE": "..." } ] }` (HTTP 200 either way); an `ERROR` is
 * the supplier's refusal, anything else that is not a success is an unusable answer.
 *
 * @param body the parsed JSON body
 * @returns the first success entry, the error message, or why the body is unusable
 */
export function parseDhruAnswer(body: unknown): DhruAnswer {
  const root = asRecord(body);
  if (!root) return { kind: 'invalid', message: 'The supplier answered with something that is not a Dhru answer.' };
  if (root.ERROR !== undefined) {
    const entry = firstOf(root.ERROR);
    const message = textOf(entry?.MESSAGE) || textOf(entry?.message) || textOf(root.ERROR) || 'The supplier refused.';
    return { kind: 'error', message };
  }
  const success = firstOf(root.SUCCESS);
  if (success) return { kind: 'success', payload: success };
  return { kind: 'invalid', message: 'The supplier answer has neither SUCCESS nor ERROR.' };
}

/** The supplier account as `accountinfo` reports it. */
export interface AccountInfo {
  /** Our prepaid balance at the supplier, 4 decimals, in the supplier's own currency. */
  readonly credit: string;
  readonly currency: string | null;
  readonly mail: string | null;
}

/** A member the object itself holds (never one it inherits, such as `__proto__`), or `undefined`. */
function ownMember(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The supplier's own entry of one service, as it was sent.
 *
 * Why: `supplier_services.raw` archives what the supplier said; the schema's reading may have dropped a field of an unexpected type, so
 * the archive takes the entry from the payload itself.
 *
 * @param payload the success entry of `imeiservicelist`
 * @param groupKey the key of the group in `LIST`
 * @param serviceKey the key of the service in the group's `SERVICES`
 * @returns the entry as sent, or `undefined` when it is not an object
 */
function sentEntry(
  payload: Record<string, unknown>,
  groupKey: string,
  serviceKey: string,
): Record<string, unknown> | undefined {
  const entry = ownMember(ownMember(ownMember(payload, 'LIST'), groupKey), 'SERVICES');
  const service = ownMember(entry, serviceKey);
  return typeof service === 'object' && service !== null && !Array.isArray(service)
    ? (service as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the answer of `accountinfo`.
 *
 * Why: the schema of `SUPPLIER accountinfo` decides whether the answer is usable; an answer it refuses has no readable credit.
 *
 * @param payload the success entry
 * @returns the balance and who the account is, or the reason it cannot be read
 */
export function readAccountInfo(
  payload: Record<string, unknown>,
): { ok: true; value: AccountInfo } | { ok: false; message: string } {
  const entry = accountInfoCall.success.safeParse(payload);
  // The standard spells the key `AccoutInfo` (sic); a corrected spelling is accepted too.
  const info = entry.success ? (entry.data.AccoutInfo ?? entry.data.AccountInfo) : undefined;
  const credit = amountText(info?.credit);
  if (!info || credit === undefined) return { ok: false, message: 'The supplier answer has no readable credit.' };
  return {
    ok: true,
    value: { credit, currency: textOf(info.currency) || null, mail: textOf(info.mail) || null },
  };
}

/** One service of a supplier's list, normalised. */
export interface RemoteService {
  readonly remoteId: string;
  readonly group: string;
  readonly type: string;
  readonly name: string;
  /** The price in supplier credits, 4 decimals. */
  readonly credit: string;
  readonly time: string;
  /** The `Requires.*` flags without the custom fields. */
  readonly requires: Record<string, unknown>;
  /** The `Requires.Custom` field descriptions. */
  readonly customFields: unknown[];
  readonly raw: Record<string, unknown>;
}

const MAX_NAME = 300;

/**
 * Reads the answer of `imeiservicelist`.
 *
 * Why: decision 026: `LIST: { <group>: { GROUPNAME, GROUPTYPE, SERVICES: { <id>: { SERVICEID, SERVICENAME, CREDIT, TIME,
 * Requires.* } } } }`. A service with no id, no name or no readable price is left out (it cannot be imported or priced).
 *
 * @param payload the success entry
 * @returns the services, each once (the first one wins when an id repeats)
 */
export function readServiceList(payload: Record<string, unknown>): RemoteService[] {
  // The schema of `SUPPLIER imeiservicelist` is lenient on purpose: a group or service of the wrong shape arrives as `undefined` and is skipped.
  const entry = serviceListCall.success.safeParse(payload);
  const list = entry.success ? entry.data.LIST : undefined;
  const found = new Map<string, RemoteService>();
  for (const [groupKey, group] of Object.entries(list ?? {})) {
    const services = group?.SERVICES;
    if (!group || !services) continue;
    const groupName = textOf(group.GROUPNAME) || groupKey;
    const groupType = textOf(group.GROUPTYPE);
    for (const [serviceKey, service] of Object.entries(services)) {
      if (!service) continue;
      const remoteId = textOf(service.SERVICEID) || serviceKey;
      const name = textOf(service.SERVICENAME).slice(0, MAX_NAME);
      const credit = amountText(service.CREDIT);
      if (remoteId === '' || name === '' || credit === undefined || found.has(remoteId)) continue;
      const requires: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(service)) {
        if (key !== 'Requires.Custom' && key.startsWith('Requires.')) requires[key.slice('Requires.'.length)] = value;
      }
      found.set(remoteId, {
        remoteId,
        group: groupName,
        type: groupType || textOf(service.SERVICETYPE) || 'IMEI',
        name,
        credit: Decimal.max(credit, 0).toFixed(4),
        time: textOf(service.TIME),
        requires,
        customFields: service['Requires.Custom'] ?? [],
        raw: sentEntry(payload, groupKey, serviceKey) ?? service,
      });
    }
  }
  return [...found.values()];
}

/**
 * Reads the answer of `placeimeiorder`.
 *
 * @param payload the success entry
 * @returns the supplier's reference of the order, or `undefined` when the answer has none
 */
export function readPlacedOrder(payload: Record<string, unknown>): string | undefined {
  const entry = placeOrderCall.success.safeParse(payload);
  return entry.success ? textOf(entry.data.REFERENCEID).slice(0, 200) : undefined;
}

/** What a supplier says about one order. */
export interface SupplierOrderStatus {
  /** Our word for the supplier's STATUS: 4 completed, 3 rejected, 0, 1 (and 2) still running. */
  readonly state: 'completed' | 'rejected' | 'running';
  /** The CODE (the result of a completed order, the reason of a rejected one). */
  readonly code: string | null;
}

/**
 * Reads the answer of `getimeiorder`.
 *
 * @param payload the success entry
 * @returns the state and the CODE, or `undefined` when the STATUS is missing or unknown
 */
export function readOrderStatus(payload: Record<string, unknown>): SupplierOrderStatus | undefined {
  const entry = getOrderCall.success.safeParse(payload);
  if (!entry.success) return undefined;
  const status = Number(textOf(entry.data.STATUS));
  const code = textOf(entry.data.CODE);
  if (status === 4) return { state: 'completed', code: code === '' ? null : code };
  if (status === 3) return { state: 'rejected', code: code === '' ? null : code };
  if (status === 0 || status === 1 || status === 2) return { state: 'running', code: null };
  return undefined;
}

const SECRET_KEY = /(^|[^a-z])(apiaccesskey|api_?key|password|secret|token|authorization)([^a-z]|$)/i;
const DEVICE_KEY = /^(imei|imei2|serial|serialno|sn|meid)$/i;
const BULLETS = '••••••••';
const MAX_STORED_CHARS = 20_000;

/**
 * Masks what must not be kept in a stored call body.
 *
 * Why: orders-suppliers-3 and decision 023: credentials are never stored (replaced by bullets) and IMEIs are redacted (only the
 * last four characters stay, so support can still match a call to an order). A body that is too large is replaced by a note.
 *
 * @param value the request or response as JSON
 * @returns a copy with the secrets and IMEIs masked
 */
export function redactBody(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value, 0);
  const object = asRecord(redacted) ?? { value: redacted };
  return JSON.stringify(object).length > MAX_STORED_CHARS
    ? { truncated: true, note: 'The body is too large to keep.' }
    : object;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 12) return '…';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const object = asRecord(value);
  if (!object) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(object)) {
    if (SECRET_KEY.test(key)) out[key] = BULLETS;
    else if (DEVICE_KEY.test(key) && typeof inner === 'string' && inner !== '')
      out[key] = `${BULLETS}${inner.slice(-4)}`;
    else out[key] = redactValue(inner, depth + 1);
  }
  return out;
}
