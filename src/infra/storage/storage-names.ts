// Validation of what goes into object storage names and headers (decision 004): object keys, content types and the
// download file name. Pure functions, unit-tested without S3.

const KEY_MAX_LENGTH = 512;
/** Slash-separated segments; every segment starts with a letter or digit, so there is no `.`/`..` segment and no `//`. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._=+-]*(\/[A-Za-z0-9][A-Za-z0-9._=+-]*)*$/;
const TOKEN = '[a-z0-9][a-z0-9!#$&^_.+-]*';
const CONTENT_TYPE_PATTERN = new RegExp(`^${TOKEN}/${TOKEN}(\\s*;\\s*[a-z0-9-]+=("[^"]*"|[^\\s;"]+))*$`, 'i');

/**
 * Checks an object key.
 *
 * Why: keys are built by the files module from ids (`files/2026/10/<uuid>`), never from user input; this check keeps a
 * bug or a hostile file name from creating odd keys (path tricks, control characters, 1 KB names).
 *
 * @param key the object key
 * @throws {RangeError} when the key is empty, longer than 512 characters, or has a segment that is empty, starts with
 *   `.` or contains a character outside letters, digits and `. _ = + -`
 */
export function assertObjectKey(key: string): void {
  if (key.length === 0 || key.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(key)) {
    throw new RangeError(
      `"${key.slice(0, 80)}" is not a valid object key (letters, digits and . _ = + - in "/" segments)`,
    );
  }
}

/**
 * Checks a media type such as `application/pdf` or `text/csv; charset=utf-8`.
 *
 * Why: the type is stored with the object and sent back on download; a malformed value would break the response header.
 *
 * @param contentType the media type
 * @throws {RangeError} when it is not `type/subtype` with optional parameters
 */
export function assertContentType(contentType: string): void {
  if (contentType.length > 200 || !CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new RangeError(`"${contentType.slice(0, 80)}" is not a valid content type`);
  }
}

/** Replaces control characters, quotes and path separators in a file name and bounds its length. */
function cleanFilename(filename: string): string {
  let cleaned = '';
  for (const character of filename) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f || '"\\/'.includes(character) ? '_' : character;
  }
  return Array.from(cleaned.trim()).slice(0, 180).join('') || 'download';
}

/**
 * Builds the `Content-Disposition` value that makes a browser save a file under the given name.
 *
 * Why: files download through short-lived signed links with `attachment` (contract GET /admin/files/:id), and the name
 * comes from the upload (`files.filename`), so it is cleaned: no quotes, slashes or control characters that could break
 * the header, an ASCII fallback for old clients and the RFC 5987 UTF-8 form for everyone else.
 *
 * @param filename the original file name
 * @returns for example `attachment; filename="report.csv"; filename*=UTF-8''report.csv`
 */
export function attachmentDisposition(filename: string): string {
  const cleaned = cleanFilename(filename);
  const ascii = Array.from(cleaned, (character) => (/^[\x20-\x7e]$/.test(character) ? character : '_')).join('');
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
