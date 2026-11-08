// TelegramLinking: connecting a merchant's Telegram chat (feature 12a, MISMATCHES B165): the one-time link of `POST /client/telegram/link`
// and the bot's update webhook `POST /webhooks/telegram/:secret` that spends it (`/start <token>`) or ends it (`/stop`).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { NotificationService, TELEGRAM_LINKED_EVENT, TELEGRAM_UNLINKED_EVENT, withoutTelegram } from '../../platform';
import { consumeAuthToken, insertAuthToken } from '../infra/auth-token.repository';
import {
  findTelegramLinkByHash,
  lockClient,
  lockClientByChat,
  saveTelegramChat,
  voidTelegramLinks,
} from '../infra/merchant-notification.repository';

/** A Telegram link works for 15 minutes (B165). */
export const TELEGRAM_LINK_TTL_MS = 15 * 60 * 1000;

/** What `POST /client/telegram/link` answers. */
export interface TelegramLink {
  readonly url: string;
  readonly expiresAt: string;
}

/** What the bot understood from an update. */
type Command = { readonly kind: 'start'; readonly token: string } | { readonly kind: 'stop' };

/** What an update carries that the bot reads: the id, the chat and the command. */
interface ParsedUpdate {
  readonly updateId: number | undefined;
  readonly chatId: string;
  readonly command: Command;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the part of a Telegram update the bot acts on.
 *
 * Why: B165: `/start <token>` links, `/stop` unlinks, anything else is ignored. The update comes from the network, so every field is
 * checked: only a text message in a private chat counts (a group would let anyone in it spend a merchant's link).
 *
 * @param update the JSON body of the webhook call
 * @returns the id, chat and command, or `undefined` for an update to ignore
 */
export function parseTelegramUpdate(update: unknown): ParsedUpdate | undefined {
  if (!isRecord(update) || !isRecord(update['message'])) return undefined;
  const message = update['message'];
  const chat = message['chat'];
  const text = message['text'];
  if (!isRecord(chat) || chat['type'] !== 'private' || typeof text !== 'string') return undefined;
  const rawChatId = chat['id'];
  if (typeof rawChatId !== 'number' && typeof rawChatId !== 'string') return undefined;
  const chatId = String(rawChatId);
  if (!/^-?\d{1,20}$/.test(chatId)) return undefined;
  const updateId =
    typeof update['update_id'] === 'number' && Number.isSafeInteger(update['update_id'])
      ? update['update_id']
      : undefined;
  const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,128})\s*$/.exec(text);
  if (start?.[1]) return { updateId, chatId, command: { kind: 'start', token: start[1] } };
  if (/^\/stop(?:@\w+)?\s*$/.test(text)) return { updateId, chatId, command: { kind: 'stop' } };
  return undefined;
}

/**
 * Links and unlinks Telegram chats.
 *
 * Why: B165. A merchant asks for a link (`https://t.me/<bot>?start=<token>`): a single-use `telegram_link` token of 15 minutes, stored only
 * as a keyed hash, and a new call revokes the previous one. Opening it makes Telegram send `/start <token>` to the webhook: a live token
 * sets the merchant's `telegram_chat_id` (a chat that another merchant had moves to this one) and is spent, then the bot answers "Linked to
 * <merchant name>." through the notification path. `/stop` clears the chat of the merchant linked to it and turns its Telegram events off.
 * Every update is processed once: the answer is a `notifications` row with the dedupe key `telegram-update-<update_id>`, checked first, and
 * the token is single-use, so a repeated update changes nothing.
 *
 * Side effects: `createLink` inserts an `auth_tokens` row and voids the merchant's older links; `handleUpdate` updates `clients`
 * (`telegram_chat_id`, `notification_prefs`), spends a token and enqueues one Telegram notification.
 *
 * @see docs/contract/MISMATCHES.md (B165)
 */
@Injectable()
export class TelegramLinking {
  private readonly logger = new Logger(TelegramLinking.name);

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Makes the one-time link of a merchant.
   *
   * @param clientId the signed-in merchant
   * @param ip the address of the request, for the record
   * @returns the link and when it stops working
   * @throws {AppError} `UNAVAILABLE` (503) when the bot's username is not configured
   */
  async createLink(clientId: number, ip: string): Promise<TelegramLink> {
    const username = this.config.telegram.botUsername;
    if (username === undefined) throw new AppError('UNAVAILABLE', { detail: 'Telegram is not set up on this server.' });
    const now = this.clock.now();
    const token = this.tokens.random(32);
    const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS);
    await this.db.runInTransaction(async ({ tx }) => {
      // Lock the merchant first, so two parallel calls take turns: the newest link is the only one left.
      await lockClient(tx, clientId);
      await voidTelegramLinks(tx, clientId, now);
      await insertAuthToken(tx, {
        purpose: 'telegram_link',
        subjectType: 'client',
        subjectId: clientId,
        tokenHash: this.tokens.hash(token),
        expiresAt,
        ip,
        createdAt: now,
        updatedAt: now,
      });
    });
    return { url: `https://t.me/${username}?start=${token}`, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Handles one update of the bot.
   *
   * Why: the webhook answers 200 for everything after the database write, so Telegram never retries because of a refusal here; an update
   * that is not a command, a token that is unknown, used or expired, and a chat nobody has linked are all ignored without an answer.
   *
   * @param update the JSON body of the webhook call
   * @throws {Error} when Postgres fails (the webhook answers 5xx and Telegram sends the update again; the dedupe key makes that safe)
   */
  async handleUpdate(update: unknown): Promise<void> {
    const parsed = parseTelegramUpdate(update);
    if (!parsed) return;
    const dedupeKey = parsed.updateId === undefined ? undefined : `telegram-update-${parsed.updateId}`;
    // A repeated update (Telegram sends one again when our answer was slow) was processed already.
    if (dedupeKey !== undefined && (await this.notifications.statusOf(dedupeKey)) !== undefined) return;
    if (parsed.command.kind === 'start') await this.link(parsed.chatId, parsed.command.token, dedupeKey);
    else await this.unlink(parsed.chatId, dedupeKey);
  }

  /** `/start <token>`: spends the token and links the chat. */
  private async link(chatId: string, token: string, dedupeKey: string | undefined): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      const link = await findTelegramLinkByHash(tx, this.tokens.hash(token));
      if (!link) return;
      // Lock the merchant before the token is spent: `lockClient` and a parallel save of the preferences take turns.
      const client = await lockClient(tx, link.subjectId);
      if (!client || client.status === 'suspended') return;
      const spent = await consumeAuthToken(tx, link.id, now);
      if (!spent) return;
      // B165: a chat linked to another merchant moves to this one.
      const previous = await lockClientByChat(tx, chatId, client.id);
      if (previous) await saveTelegramChat(tx, previous.id, null, withoutTelegram(previous.notificationPrefs), now);
      await saveTelegramChat(tx, client.id, chatId, client.notificationPrefs, now);
      await this.notifications.enqueue(
        { tx },
        {
          event: TELEGRAM_LINKED_EVENT,
          recipient: { type: 'client', id: client.id },
          channel: 'telegram',
          variables: { merchantName: client.name },
          chatId,
          ...(dedupeKey === undefined ? {} : { dedupeKey }),
        },
      );
    });
  }

  /** `/stop`: clears the chat of the merchant linked to it and turns its Telegram events off. */
  private async unlink(chatId: string, dedupeKey: string | undefined): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      const client = await lockClientByChat(tx, chatId);
      if (!client) return;
      await saveTelegramChat(tx, client.id, null, withoutTelegram(client.notificationPrefs), now);
      // The chat is no longer on the merchant, so the answer carries it.
      const result = await this.notifications.enqueue(
        { tx },
        {
          event: TELEGRAM_UNLINKED_EVENT,
          recipient: { type: 'client', id: client.id },
          channel: 'telegram',
          variables: { merchantName: client.name },
          chatId,
          ...(dedupeKey === undefined ? {} : { dedupeKey }),
        },
      );
      if (result.status === 'skipped')
        this.logger.debug(`No answer to /stop for merchant ${client.id}: ${result.reason}`);
    });
  }
}
