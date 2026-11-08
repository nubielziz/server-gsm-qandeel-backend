// Drizzle queries of a merchant's notification settings on `clients` and `auth_tokens` (identity module, feature 12a): the preferences, the
// linked Telegram chat and the single-use `telegram_link` tokens. Every function takes a DbExecutor; times come from the caller.
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type AuthToken, type Client, authTokens, clients } from '../db/schema';

/**
 * Reads a merchant and locks the row for the rest of the transaction.
 *
 * Why: a save of the preferences and a Telegram link both rewrite `notification_prefs` and `telegram_chat_id`; the lock makes them take
 * turns, so neither overwrites the other.
 *
 * @param db the caller's transaction
 * @param id the merchant id
 * @returns the merchant, or `undefined`
 */
export async function lockClient(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1).for('update');
  return row;
}

/**
 * Reads the merchant that has a Telegram chat linked, and locks the row.
 *
 * @param db the caller's transaction
 * @param chatId the Telegram chat id
 * @param exceptId a merchant to leave out
 * @returns the merchant, or `undefined` when nobody has the chat
 */
export async function lockClientByChat(db: DbExecutor, chatId: string, exceptId?: number): Promise<Client | undefined> {
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.telegramChatId, chatId), exceptId === undefined ? undefined : ne(clients.id, exceptId)))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Saves a merchant's notification preferences.
 *
 * @param db the caller's transaction
 * @param id the merchant id
 * @param prefs the whole new `notification_prefs` object
 * @param now the time from the injected clock
 */
export async function saveNotificationPrefs(
  db: DbExecutor,
  id: number,
  prefs: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await db.update(clients).set({ notificationPrefs: prefs, updatedAt: now }).where(eq(clients.id, id));
}

/**
 * Sets or clears a merchant's linked Telegram chat, with the preferences that go with it.
 *
 * @param db the caller's transaction
 * @param id the merchant id
 * @param chatId the chat id, or `null` to unlink
 * @param prefs the whole new `notification_prefs` object
 * @param now the time from the injected clock
 */
export async function saveTelegramChat(
  db: DbExecutor,
  id: number,
  chatId: string | null,
  prefs: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await db
    .update(clients)
    .set({ telegramChatId: chatId, notificationPrefs: prefs, updatedAt: now })
    .where(eq(clients.id, id));
}

/**
 * Marks every unused `telegram_link` token of a merchant used, so only the newest link works.
 *
 * Why: B165: a new call to `POST /client/telegram/link` revokes the previous one. The table has no "revoked" column, so a voided token
 * is marked used (the same rule as the other links).
 *
 * @param db the caller's transaction
 * @param clientId the merchant
 * @param now the time from the injected clock
 * @returns how many tokens were voided
 */
export async function voidTelegramLinks(db: DbExecutor, clientId: number, now: Date): Promise<number> {
  const rows = await db
    .update(authTokens)
    .set({ usedAt: now, updatedAt: now })
    .where(
      and(
        eq(authTokens.subjectType, 'client'),
        eq(authTokens.subjectId, clientId),
        eq(authTokens.purpose, 'telegram_link'),
        isNull(authTokens.usedAt),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length;
}

/**
 * Finds a `telegram_link` token by its hash.
 *
 * @param db the database or a transaction
 * @param tokenHash the keyed hash of the token the merchant sent to the bot
 * @returns the row (used or not), or `undefined`
 */
export async function findTelegramLinkByHash(db: DbExecutor, tokenHash: string): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.purpose, 'telegram_link'),
        eq(authTokens.subjectType, 'client'),
      ),
    )
    .limit(1);
  return row;
}
