// The attachment rules of the support chat (feature 28, rule 8): which files a ticket message may carry and how an upload's content is
// recognised. Pure: the use cases and their unit tests call it.

/**
 * The media types a ticket attachment may have: PDF, JPEG and PNG.
 *
 * Why: feature 28, rule 8: there is no virus scanner in the stack, so only the three document types the storefront
 * already takes for a receipt, never shown inline.
 */
export const ATTACHMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

/** One value of {@link ATTACHMENT_MIME_TYPES}. */
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

/** The largest attachment: 5 MiB (rule 8). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** The most files one message carries (rule 8). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

/**
 * Recognises an attachment by its first bytes.
 *
 * Why: rule 8: the declared type and the file name come from the client; the content must start with the magic bytes of the type, so a
 * renamed program is refused.
 *
 * @param bytes the file content
 * @returns the media type the content is, or `undefined` for anything that is none of the three
 */
export function sniffAttachment(bytes: Uint8Array): AttachmentMime | undefined {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  return undefined;
}

/** Why an upload is refused, as the `code` of the field error on `file`; `too_large` is answered as `413`. */
export type UploadProblem = 'empty' | 'too_large' | 'type';

/**
 * Judges an uploaded attachment.
 *
 * Why: rule 8: 1 byte to 5 MiB, a declared PDF, JPEG or PNG, and content that agrees with the declared type.
 *
 * @param mime the declared media type, already cleaned (`cleanMediaType`)
 * @param bytes the content
 * @returns the problem, or `undefined` when the file may be stored
 */
export function uploadProblem(mime: string, bytes: Uint8Array): UploadProblem | undefined {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > MAX_ATTACHMENT_BYTES) return 'too_large';
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)) return 'type';
  return sniffAttachment(bytes) === mime ? undefined : 'type';
}

/** Who sends a message with attachments, as the `files` table names owners. */
export interface FileOwner {
  readonly type: 'account' | 'staff';
  readonly id: number;
}

/** What the attach check needs to know about a stored file. */
export interface AttachableFile {
  readonly ownerType: string;
  readonly ownerId: number;
  /** The first segment of the file's object key (`tickets-42`, `receipts`, `files`). */
  readonly area: string;
  readonly mime: string;
  readonly size: number;
}

/**
 * The storage area of the files a ticket's requester uploads through the ticket link: one area per ticket.
 *
 * Why: feature 28, rule 8: the link is the whole credential of the ticket page (decision 010), and whoever holds it (an order tracking
 * link opens a ticket on the spot) must not reach the customer's other files (their tax receipts, bank transfer receipts, the uploads of
 * their other tickets). A link writer may attach only the files of this area; a staff upload stays in the shared area `tickets`.
 *
 * @param ticketId the ticket
 * @returns the area, `tickets-<id>`
 */
export function ticketUploadArea(ticketId: number): string {
  return `tickets-${ticketId}`;
}

/** Why a file id of a message is refused, as the `code` of the field error on `fileIds`. */
export type AttachProblem = 'unknown_file' | 'not_yours' | 'type' | 'too_large';

/**
 * Judges one file a message wants to carry.
 *
 * Why: rule 8 and the plan's § 3.3: the sender attaches only their own uploads (the ticket's requester, an account of any rank, or the staff
 * member), and only PDF, JPEG or PNG of at most 5 MiB (a merchant rank's portal upload may be any file of 25 MiB). A ticket link's holder attaches only
 * the files uploaded through that ticket ({@link ticketUploadArea}): another file of the same customer is `not_yours` too.
 *
 * @param file the stored file, or `undefined` when the id names none
 * @param sender the owner the file must have
 * @param onlyArea the area the file must have as well (a link writer's ticket area), or `undefined` for no area check
 * @returns the problem, or `undefined` when the file may be attached
 */
export function attachProblem(
  file: AttachableFile | undefined,
  sender: FileOwner,
  onlyArea?: string,
): AttachProblem | undefined {
  if (!file) return 'unknown_file';
  if (file.ownerType !== sender.type || file.ownerId !== sender.id) return 'not_yours';
  if (onlyArea !== undefined && file.area !== onlyArea) return 'not_yours';
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.mime)) return 'type';
  return file.size > MAX_ATTACHMENT_BYTES ? 'too_large' : undefined;
}
