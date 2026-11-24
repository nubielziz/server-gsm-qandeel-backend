// Which channels a staff reply may use (support module, RULES support 6, ANSWERS support Q2): email, to a requester that can be reached.
// Pure; the detail read and the reply use case share it.
/** The ways a reply can go out. */
export const REPLY_CHANNELS = ['email'] as const;

/** One value of {@link REPLY_CHANNELS}. */
export type ReplyChannel = (typeof REPLY_CHANNELS)[number];

/** What decides the channels of a ticket. */
export interface ReplyTarget {
  /** False for a requester that is gone or anonymized: nothing may be sent to them. */
  readonly reachable: boolean;
}

/**
 * Lists the channels a reply to this requester may use.
 *
 * Why: ANSWERS support Q2: `['email']`. A requester that was anonymized (or is gone) cannot be written to, so the list is empty and a reply
 * is refused rather than sent to a redacted address.
 *
 * @param target who the ticket belongs to
 * @returns `['email']`, or an empty list for a requester that cannot be reached
 */
export function replyChannelsOf(target: ReplyTarget): ReplyChannel[] {
  return target.reachable ? ['email'] : [];
}

/**
 * Picks the channel of a reply.
 *
 * Why: RULES support 6: a channel the caller names must be one of the ticket's; without one the reply goes by email (M148,
 * `Composer.tsx`). A ticket that an older version opened on another channel is answered by email too.
 *
 * @param requested the channel the body named, if any
 * @param allowed the channels of {@link replyChannelsOf}
 * @returns the channel, or `undefined` when none is possible (the named one is not allowed, or nothing is)
 */
export function pickReplyChannel(
  requested: ReplyChannel | undefined,
  allowed: readonly ReplyChannel[],
): ReplyChannel | undefined {
  if (requested !== undefined) return allowed.includes(requested) ? requested : undefined;
  return allowed.includes('email') ? 'email' : undefined;
}
