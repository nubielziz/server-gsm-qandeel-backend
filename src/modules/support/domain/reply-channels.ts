// Which channels a staff reply may use (support module, RULES support 6, ANSWERS support Q2): email always, Telegram only to a linked chat.
// Pure; the detail read and the reply use case share it.
import type { TicketChannel, TicketRequesterType } from '../db/schema';

/** The ways a reply can go out. */
export const REPLY_CHANNELS = ['email', 'telegram'] as const;

/** One value of {@link REPLY_CHANNELS}. */
export type ReplyChannel = (typeof REPLY_CHANNELS)[number];

/** What decides the channels of a ticket. */
export interface ReplyTarget {
  readonly requesterType: TicketRequesterType;
  /** False for a requester that is gone or anonymized: nothing may be sent to them. */
  readonly reachable: boolean;
  /** A merchant's linked Telegram chat; always `null` for a customer (they have no chat with the bot). */
  readonly telegramChatId: string | null;
}

/**
 * Lists the channels a reply to this requester may use.
 *
 * Why: ANSWERS support Q2: `['email']`, plus `'telegram'` when the requester has a linked chat (merchants, through
 * `clients.telegram_chat_id`). A requester that was anonymized (or is gone) cannot be written to, so the list is empty and a reply
 * is refused rather than sent to a redacted address.
 *
 * @param target who the ticket belongs to
 * @returns the channels in the console's order (email first)
 */
export function replyChannelsOf(target: ReplyTarget): ReplyChannel[] {
  if (!target.reachable) return [];
  const channels: ReplyChannel[] = ['email'];
  if (target.requesterType === 'client' && target.telegramChatId !== null) channels.push('telegram');
  return channels;
}

/**
 * Picks the channel of a reply.
 *
 * Why: RULES support 6: a channel the caller names must be one of the ticket's; without one the reply uses the ticket's own channel
 * when it is allowed, else email (M148, `Composer.tsx`).
 *
 * @param requested the channel the body named, if any
 * @param ticketChannel where the ticket came from
 * @param allowed the channels of {@link replyChannelsOf}
 * @returns the channel, or `undefined` when none is possible (the named one is not allowed, or nothing is)
 */
export function pickReplyChannel(
  requested: ReplyChannel | undefined,
  ticketChannel: TicketChannel,
  allowed: readonly ReplyChannel[],
): ReplyChannel | undefined {
  if (requested !== undefined) return allowed.includes(requested) ? requested : undefined;
  if (ticketChannel === 'telegram' && allowed.includes('telegram')) return 'telegram';
  return allowed.includes('email') ? 'email' : undefined;
}
