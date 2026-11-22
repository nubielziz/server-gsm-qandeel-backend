// The Dhru Fusion client side (decisions 026 and 042): the request an outbound supplier call sends and how each answer is read. Pure,
// so the fake supplier of the tests and the real one are judged by the same code. Serves the supplier calls of stage 6; every answer is
// read through the schema of its contract (`contracts/supplier-calls.contracts.ts`).
import { accountInfoCall, getOrderCall, placeOrderCall, serviceListCall } from '../contracts/supplier-calls.contracts';
import type { SupplierParamFormat } from '../db/schema';
import { SUPPLIER_BALANCE_RANGE, SUPPLIER_PRICE_RANGE, amountText, supplierAmount } from './amount-text';
import {
  SUPPLIER_LABEL_MAX,
  SUPPLIER_MESSAGE_MAX,
  SUPPLIER_REFERENCE_MAX,
  SUPPLIER_RESULT_MAX,
  supplierBlock,
  supplierLine,
} from './supplier-text';

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

/**
 * The two forms a Dhru supplier reads `parameters` in (decision 042): `dhru_xml` is the plain XML string of the classic Dhru client,
 * `json` is base64 of a JSON object (the standards v6.1 form of decision 026). The values of `suppliers.param_format`.
 */
export type DhruParamFormat = SupplierParamFormat;

/** What a call needs to build the request body. */
export interface DhruRequestInput {
  readonly username: string;
  readonly apiKey: string;
  readonly action: DhruAction;
  /** The form the supplier reads `parameters` in (its `param_format`); no default here on purpose. */
  readonly format: DhruParamFormat;
  /** The action's parameters, written in {@link DhruRequestInput.format}. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/** A parameter name of the classic XML form: upper case letters, digits and `_`, starting with a letter. */
const XML_KEY = /^[A-Z][A-Z0-9_]*$/;

/** Whether a code point may stand in an XML 1.0 document (the controls but tab, line feed and carriage return, U+FFFE, U+FFFF and lone surrogates may not). */
function xmlAllowed(codePoint: number): boolean {
  if (codePoint < 0x20) return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  return codePoint !== 0xfffe && codePoint !== 0xffff;
}

/** The text of one XML value: forbidden characters removed, `&`, `<` and `>` escaped. */
function xmlText(value: string): string {
  let out = '';
  // Iterating a string yields code points: a valid surrogate pair arrives whole, a lone surrogate alone.
  for (const char of value) {
    if (!xmlAllowed(char.codePointAt(0)!)) continue;
    out += char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char;
  }
  return out;
}

/**
 * Writes Dhru parameters as the classic XML string.
 *
 * Why: decision 042 (feature 33): a Dhru Fusion site reads `parameters` only as the plain XML string the classic Dhru client builds
 * (`<PARAMETERS><ID>..</ID><IMEI>..</IMEI></PARAMETERS>`, upper-case keys, no base64); base64 of JSON is refused with
 * `Parameter 'ID' Required`.
 *
 * @param parameters the parameters, in the order they are written; `null` and `undefined` values are left out
 * @returns `<PARAMETERS>` + one `<KEY>value</KEY>` per own key + `</PARAMETERS>`, without a declaration or whitespace
 * @throws {Error} when a key, upper-cased, is not `^[A-Z][A-Z0-9_]*$`, or a value is not a string, a finite number or a boolean (the
 *   keys and values come from the typed call contracts, so this is a programming error)
 */
export function dhruParametersXml(parameters: Readonly<Record<string, unknown>>): string {
  let xml = '<PARAMETERS>';
  for (const name of Object.keys(parameters)) {
    const key = name.toUpperCase();
    if (!XML_KEY.test(key)) throw new Error(`A Dhru parameter name cannot be written as XML: ${JSON.stringify(name)}.`);
    const value = parameters[name];
    if (value === null || value === undefined) continue;
    let text: string;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'boolean') text = String(value);
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else throw new Error(`The Dhru parameter ${key} has a value that cannot be written as XML (${typeof value}).`);
    xml += `<${key}>${xmlText(text)}</${key}>`;
  }
  return `${xml}</PARAMETERS>`;
}

/**
 * Builds the form body of a Dhru call.
 *
 * Why: decisions 026 and 042: `application/x-www-form-urlencoded` with `username`, `apiaccesskey`, `action`, `requestformat=JSON` and
 * `parameters` in the supplier's form: the classic XML string ({@link dhruParametersXml}) for `dhru_xml`, base64 of a JSON object for
 * `json`. The caller has already turned `CUSTOMFIELD` into base64 of JSON (both forms carry it that way).
 *
 * @param input the credentials, the action, the supplier's parameter form and the parameters
 * @returns the body to post
 * @throws {Error} from {@link dhruParametersXml} for a parameter that cannot be written as XML
 */
export function dhruRequestBody(input: DhruRequestInput): URLSearchParams {
  const body = new URLSearchParams({
    username: input.username,
    apiaccesskey: input.apiKey,
    action: input.action,
    requestformat: 'JSON',
  });
  if (input.parameters !== undefined) {
    body.set(
      'parameters',
      input.format === 'dhru_xml'
        ? dhruParametersXml(input.parameters)
        : Buffer.from(JSON.stringify(input.parameters), 'utf8').toString('base64'),
    );
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

/** The text of a STATUS: a string or a number, trimmed. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/**
 * Reads a Dhru answer body.
 *
 * Why: decision 026: `{ "SUCCESS": [ ... ] }` or `{ "ERROR": [ { "MESSAGE": "..." } ] }` (HTTP 200 either way); an `ERROR` is
 * the supplier's refusal, anything else that is not a success is an unusable answer. Decision 051: the message is one line of at most
 * 500 characters without control characters, because it is stored in events and call logs and shown to staff.
 *
 * @param body the parsed JSON body
 * @returns the first success entry, the error message, or why the body is unusable
 */
export function parseDhruAnswer(body: unknown): DhruAnswer {
  const root = asRecord(body);
  if (!root) return { kind: 'invalid', message: 'The supplier answered with something that is not a Dhru answer.' };
  if (root.ERROR !== undefined) {
    const entry = firstOf(root.ERROR);
    const message =
      supplierLine(entry?.MESSAGE, SUPPLIER_MESSAGE_MAX) ||
      supplierLine(entry?.message, SUPPLIER_MESSAGE_MAX) ||
      supplierLine(root.ERROR, SUPPLIER_MESSAGE_MAX) ||
      'The supplier refused.';
    return { kind: 'error', message };
  }
  const success = firstOf(root.SUCCESS);
  if (success) return { kind: 'success', payload: success };
  return { kind: 'invalid', message: 'The supplier answer has neither SUCCESS nor ERROR.' };
}

/** The supplier account as `accountinfo` reports it. */
export interface AccountInfo {
  /**
   * Our prepaid balance at the supplier, 4 decimals, in the supplier's own currency; `null` when the supplier reported a balance outside
   * -1000000000 to 1000000000 (it is not saved, decision 051).
   */
  readonly credit: string | null;
  readonly currency: string | null;
  readonly mail: string | null;
}

/** Why a balance outside the range is not saved: shown by the connection test (decision 051). */
export const BALANCE_OUT_OF_RANGE_MESSAGE =
  'The supplier reported a balance outside -1000000000 to 1000000000; it was not saved.';

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
 * Decision 051: a balance outside -1000000000 to 1000000000 is read (the call worked) but its `credit` is `null`, so nothing saves it.
 *
 * @param payload the success entry
 * @returns the balance (or `null` when out of range) and who the account is, or the reason it cannot be read
 */
export function readAccountInfo(
  payload: Record<string, unknown>,
): { ok: true; value: AccountInfo } | { ok: false; message: string } {
  const entry = accountInfoCall.success.safeParse(payload);
  // The standard spells the key `AccoutInfo` (sic); a corrected spelling is accepted too.
  const info = entry.success ? (entry.data.AccoutInfo ?? entry.data.AccountInfo) : undefined;
  const balance = supplierAmount(info?.credit, SUPPLIER_BALANCE_RANGE);
  if (!info || balance.kind === 'unreadable')
    return { ok: false, message: 'The supplier answer has no readable credit.' };
  return {
    ok: true,
    value: {
      credit: balance.kind === 'ok' ? balance.text : null,
      currency: supplierLine(info.currency, SUPPLIER_LABEL_MAX) || null,
      mail: supplierLine(info.mail, SUPPLIER_LABEL_MAX) || null,
    },
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

/** What {@link readServiceList} found: the services it keeps and how many entries it left out. */
export interface ServiceListReading {
  readonly services: RemoteService[];
  /** Entries left out: no id, no name, no readable price or a price outside 0 to 1000000000 (a repeated id is not counted). */
  readonly skipped: number;
}

/**
 * Reads the answer of `imeiservicelist`.
 *
 * Why: decision 026: `LIST: { <group>: { GROUPNAME, GROUPTYPE, SERVICES: { <id>: { SERVICEID, SERVICENAME, CREDIT, TIME,
 * Requires.* } } } }`. A service with no id, no name or no readable price is left out (it cannot be imported or priced). Decision 051: so
 * is one whose price is outside 0 to 1000000000, and the number left out is counted; every text it keeps is bounded (ids 200 characters,
 * names, groups, types and times 300). The payload is expected to have gone through `cleanSupplierJson` (the driver does it).
 *
 * @param payload the success entry
 * @returns the services, each once (the first one wins when an id repeats), and how many entries were left out
 */
export function readServiceList(payload: Record<string, unknown>): ServiceListReading {
  // The schema of `SUPPLIER imeiservicelist` is lenient on purpose: a group or service of the wrong shape arrives as `undefined` and is skipped.
  const entry = serviceListCall.success.safeParse(payload);
  const list = entry.success ? entry.data.LIST : undefined;
  const found = new Map<string, RemoteService>();
  let skipped = 0;
  for (const [groupKey, group] of Object.entries(list ?? {})) {
    const services = group?.SERVICES;
    if (!group || !services) continue;
    const groupName = supplierLine(group.GROUPNAME, SUPPLIER_LABEL_MAX) || supplierLine(groupKey, SUPPLIER_LABEL_MAX);
    const groupType = supplierLine(group.GROUPTYPE, SUPPLIER_LABEL_MAX);
    for (const [serviceKey, service] of Object.entries(services)) {
      if (!service) {
        skipped += 1;
        continue;
      }
      const remoteId =
        supplierLine(service.SERVICEID, SUPPLIER_REFERENCE_MAX) || supplierLine(serviceKey, SUPPLIER_REFERENCE_MAX);
      const name = supplierLine(service.SERVICENAME, SUPPLIER_LABEL_MAX);
      const price = supplierAmount(service.CREDIT, SUPPLIER_PRICE_RANGE);
      if (remoteId === '' || name === '' || price.kind !== 'ok') {
        skipped += 1;
        continue;
      }
      if (found.has(remoteId)) continue;
      const requires: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(service)) {
        if (key === 'Requires.Custom' || !key.startsWith('Requires.')) continue;
        const flag = key.slice('Requires.'.length);
        // A flag named `__proto__` would set the object's prototype instead of a member.
        if (flag !== '__proto__') requires[flag] = value;
      }
      found.set(remoteId, {
        remoteId,
        group: groupName,
        type: groupType || supplierLine(service.SERVICETYPE, SUPPLIER_LABEL_MAX) || 'IMEI',
        name,
        credit: price.text,
        time: supplierLine(service.TIME, SUPPLIER_LABEL_MAX),
        requires,
        customFields: service['Requires.Custom'] ?? [],
        raw: sentEntry(payload, groupKey, serviceKey) ?? service,
      });
    }
  }
  return { services: [...found.values()], skipped };
}

/**
 * Reads the answer of `placeimeiorder`.
 *
 * Why: decision 051: the reference is kept to 200 characters without control characters, so it can always be stored and sent back to the
 * supplier as it was kept.
 *
 * @param payload the success entry
 * @returns the supplier's reference of the order, or `undefined` when the answer has none (or only characters that are removed)
 */
export function readPlacedOrder(payload: Record<string, unknown>): string | undefined {
  const entry = placeOrderCall.success.safeParse(payload);
  if (!entry.success) return undefined;
  const reference = supplierLine(entry.data.REFERENCEID, SUPPLIER_REFERENCE_MAX);
  return reference === '' ? undefined : reference;
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
 * Why: decision 051: the CODE becomes the order's result and reaches webhooks, mails and tracking, so it is kept to 20,000 characters
 * without control characters (line breaks stay).
 *
 * @param payload the success entry
 * @returns the state and the CODE, or `undefined` when the STATUS is missing or unknown
 */
export function readOrderStatus(payload: Record<string, unknown>): SupplierOrderStatus | undefined {
  const entry = getOrderCall.success.safeParse(payload);
  if (!entry.success) return undefined;
  const status = Number(textOf(entry.data.STATUS));
  const code = supplierBlock(entry.data.CODE, SUPPLIER_RESULT_MAX);
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
 * last four characters stay, so support can still match a call to an order). The four are whole characters (decision 051): a character
 * outside the basic plane is never cut in half, so the stored text stays valid. A body that is too large is replaced by a note.
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
      out[key] = `${BULLETS}${[...inner].slice(-4).join('')}`; // by code point: never half of a surrogate pair
    else out[key] = redactValue(inner, depth + 1);
  }
  return out;
}
