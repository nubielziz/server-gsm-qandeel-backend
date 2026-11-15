// The email fallback of staff replies (feature 28, rule 9): when an unseen email reply is due, and the text of the one mail that carries
// every unseen reply. Pure.

/** The most replies one mail spells out; older ones are only counted. */
export const MAX_MAILED_REPLIES = 10;

/** The default delay before an unseen email reply is mailed (setting `support.replyEmailDelayMinutes`; the owner kept the plan's default). */
export const DEFAULT_REPLY_EMAIL_DELAY_MINUTES = 5;

/** One staff reply as the mail shows it. */
export interface MailedReply {
  readonly body: string;
  /** How many files the reply carries. */
  readonly fileCount: number;
}

const files = (count: number) => `(${count} ${count === 1 ? 'file' : 'files'} attached)`;

/**
 * The text of a reply mail: the replies oldest first, parted by a blank line.
 *
 * Why: rule 9: one mail carries every unseen reply of the ticket. At most {@link MAX_MAILED_REPLIES} are spelled out, after a line that
 * counts the earlier ones; an attachment is never mailed (the page has it), only counted.
 *
 * @param replies the unseen replies, oldest first (at least one)
 * @returns the text of the template's `{{message}}`
 */
export function replyMailText(replies: readonly MailedReply[]): string {
  const shown = replies.slice(-MAX_MAILED_REPLIES);
  const earlier = replies.length - shown.length;
  const parts = shown.map((reply) => {
    if (reply.fileCount === 0) return reply.body;
    return reply.body === '' ? files(reply.fileCount) : `${reply.body}\n${files(reply.fileCount)}`;
  });
  if (earlier > 0) parts.unshift(`… and ${earlier} earlier ${earlier === 1 ? 'message' : 'messages'}`);
  return parts.join('\n\n');
}

/**
 * When the unseen email replies of a ticket are mailed after a new reply.
 *
 * Why: rule 9: the first unseen reply starts the delay and later replies join it (`coalesce`), so one mail carries them all; a delay of
 * `0` means at once (no sweep: the reply's event is written as before).
 *
 * @param current the ticket's `reply_mail_due_at`, or `null`
 * @param now the injected clock's time
 * @param delayMinutes the setting, 1 to 1440 (`0` never reaches here: the reply's event is written at once)
 * @returns the due time to store
 */
export function replyMailDueAt(current: Date | null, now: Date, delayMinutes: number): Date {
  return current ?? new Date(now.getTime() + delayMinutes * 60_000);
}

/**
 * The id after which a staff reply is still unseen and not mailed.
 *
 * Why: rule 9: a reply the requester saw on the page, or that an earlier mail carried, is never mailed (again).
 *
 * @param requesterSeen the requester's seen mark, or `null`
 * @param mailed the newest reply a mail carried, or `null`
 * @returns the larger of the two (0 for none)
 */
export function unseenAfter(requesterSeen: number | null, mailed: number | null): number {
  return Math.max(requesterSeen ?? 0, mailed ?? 0);
}
