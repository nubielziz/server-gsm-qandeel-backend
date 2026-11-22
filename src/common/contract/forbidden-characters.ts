// The text no request may hold (decision 053): the character U+0000 and an unpaired surrogate (not well-formed Unicode), which Postgres refuses in text or jsonb. The validation guard and the Dhru gateway use it.
import { UploadedFile } from '../multipart';

/**
 * The error code of a field whose text holds U+0000 or an unpaired surrogate.
 *
 * Why: decision 053. The console maps `errors[].code` per field; `invalid_format` is the code of a value of the wrong shape.
 */
export const FORBIDDEN_TEXT_CODE = 'invalid_format';

/**
 * The message of a field whose text holds U+0000 or an unpaired surrogate.
 *
 * Why: decision 053. One sentence for every route, so a refusal never depends on the route's own schema.
 */
export const FORBIDDEN_TEXT_MESSAGE = 'Must not contain the character U+0000 or an unpaired surrogate.';

/**
 * The sentence of a Dhru call whose decoded `parameters` hold U+0000 or an unpaired surrogate.
 *
 * Why: decision 053. The Dhru surface answers every refusal as an HTTP 200 `ERROR` message, so it has its own wording of the same rule.
 */
export const FORBIDDEN_TEXT_DHRU_MESSAGE =
  'Invalid parameters: a text holds the character U+0000 or an unpaired surrogate.';

/** One step of a path, linked to its parent so a deep value does not copy its whole path at every level. */
interface PathNode {
  readonly parent: PathNode | undefined;
  readonly key: string | number;
}

interface Frame {
  readonly value: unknown;
  readonly at: PathNode | undefined;
}

function materialize(at: PathNode | undefined): (string | number)[] {
  const path: (string | number)[] = [];
  for (let node = at; node !== undefined; node = node.parent) path.push(node.key);
  return path.reverse();
}

/**
 * Tells whether a text is one the rule refuses: it holds U+0000, or it is not well-formed Unicode (a high surrogate with no low one
 * after it, or a low one with no high one before it). A valid pair (an emoji) is well formed.
 */
function holdsForbidden(text: string): boolean {
  return text.includes('\u0000') || !text.isWellFormed();
}

/**
 * Tells a plain record from a class instance.
 *
 * A record is an object whose prototype is `Object.prototype`, nothing, or an object that itself has no prototype: Fastify builds its query and
 * path parameter objects that last way (a constructor function whose prototype is `Object.create(null)`), and they must be scanned like any other
 * record. A class instance (a buffer, a date, an uploaded file) has a prototype that inherits from `Object.prototype`, so it is not a record.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * Finds the first string in a value that holds U+0000 or an unpaired surrogate.
 *
 * Why: decision 053. Postgres refuses U+0000 in text (`22021`) and in jsonb (`22P05`), and refuses an unpaired surrogate in jsonb while a
 * text column stores it replaced; a statement that fails on one branch only (a known email versus a new one, a text column versus a JSON
 * column) would answer differently and tell a caller what exists, so every request text is judged the same way before a handler runs.
 *
 * It walks the value with an explicit stack (no recursion, so any depth is safe): a string answers its path; an array pushes its
 * items; a plain object answers its own path when one of its own keys holds one of them, else pushes each value; an
 * `UploadedFile` answers its path when its field name, file name or media type holds one (its bytes are never looked at); every
 * other value (numbers, booleans, `null`, buffers, class instances) is skipped. The answer is the first offending string in
 * document order (keys in insertion order).
 *
 * @param value a request part: params, query, body or a decoded Dhru value
 * @returns the path of the first offending string (the path of the object for an offending key; empty for the value itself), or
 *   `undefined` when nothing holds U+0000 or an unpaired surrogate
 */
export function forbiddenTextPathOf(value: unknown): readonly (string | number)[] | undefined {
  const stack: Frame[] = [{ value, at: undefined }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const current = frame.value;
    if (typeof current === 'string') {
      if (holdsForbidden(current)) return materialize(frame.at);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    if (current instanceof UploadedFile) {
      if (holdsForbidden(current.fieldName) || holdsForbidden(current.filename) || holdsForbidden(current.mime))
        return materialize(frame.at);
      continue;
    }
    if (Array.isArray(current)) {
      // Children go on the stack in reverse so the first item is read first.
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], at: { parent: frame.at, key: index } });
      }
      continue;
    }
    if (!isPlainObject(current)) continue;
    const keys = Object.keys(current);
    if (keys.some(holdsForbidden)) return materialize(frame.at);
    const record = current as Record<string, unknown>;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index] as string;
      stack.push({ value: record[key], at: { parent: frame.at, key } });
    }
  }
  return undefined;
}

/** Removes U+0000 and replaces each unpaired surrogate with U+FFFD (what `toWellFormed` does), so the text is one the database accepts everywhere. */
function cleanText(text: string): string {
  return text.replaceAll('\u0000', '').toWellFormed();
}

interface CopyFrame {
  readonly source: unknown;
  readonly assign: (copy: unknown) => void;
}

/**
 * Copies a value with U+0000 removed and every unpaired surrogate replaced by U+FFFD, in every string and every object key.
 *
 * Why: decision 053. The incoming webhooks (`/webhooks/*`) are not refused for these texts (a gateway would repeat the event for
 * days and Telegram would hold back later updates), so what their handlers store (event payloads, ids, texts) is cleaned instead: the
 * signed body is accepted as usual and written without them, which Postgres would refuse in text or jsonb.
 *
 * It walks the value with an explicit stack (any depth). A value that holds nothing to clean is returned as it is (no copy). Arrays and
 * plain objects are copied; every other value (numbers, booleans, `null`, buffers, class instances) is kept as it is. A key that
 * becomes equal to another one after the cleaning is overwritten by the later one in document order.
 *
 * @param value a decoded request body
 * @returns the same value when it holds neither, otherwise a copy that holds neither
 */
export function withoutForbiddenText<T>(value: T): T {
  if (forbiddenTextPathOf(value) === undefined) return value;
  let result: unknown;
  const stack: CopyFrame[] = [{ source: value, assign: (copy) => (result = copy) }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { source, assign } = frame;
    if (typeof source === 'string') {
      assign(cleanText(source));
    } else if (Array.isArray(source)) {
      const copy: unknown[] = new Array<unknown>(source.length);
      assign(copy);
      source.forEach((item, index) => stack.push({ source: item, assign: (child) => (copy[index] = child) }));
    } else if (typeof source === 'object' && source !== null && isPlainObject(source)) {
      const copy: Record<string, unknown> = {};
      assign(copy);
      // Reversed, so the stack hands the keys back in their own order.
      for (const [key, item] of Object.entries(source).reverse()) {
        // defineProperty: a key such as "__proto__" must stay an own key of the copy, never become its prototype.
        stack.push({
          source: item,
          assign: (child) =>
            Object.defineProperty(copy, cleanText(key), {
              value: child,
              enumerable: true,
              writable: true,
              configurable: true,
            }),
        });
      }
    } else {
      assign(source);
    }
  }
  return result as T;
}
