// InboxService: the use cases behind the three inbox surfaces (feature 23, plan section 10.4): list, unread count, mark one read and
// mark all read for the signed-in person, on the staff console, the merchant portal and the storefront account.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import type { ParsedListQuery } from '../../../../common/contract';
import { AppError } from '../../../../common/errors';
import { getRequestContext } from '../../../../common/request-context';
import { DbService } from '../../../../infra/db';
import type { NotificationRecipientType } from '../../db/schema';
import { audienceOf, recipientOf } from '../notification-foreign-reads';
import { InboxTextRegistry } from './inbox-texts';
import { type WireInboxItem, inboxView } from './inbox-views';
import { type InboxOwner, countUnread, listInboxRows, markAllRead, markItemRead } from './inbox.repository';

/**
 * The signed-in person of an inbox route.
 *
 * Why: plan 10.4: the recipient is never taken from the query, the body or the path; it is the actor the session guard put in the
 * request context (the platform module cannot import identity's decorators, decision 032).
 *
 * @param type the kind of person the surface is for
 * @returns the owner of the inbox
 * @throws {AppError} `UNAUTHORIZED` when the request was not authenticated as that kind of person
 */
export function inboxOwner(type: NotificationRecipientType): InboxOwner {
  const actor = getRequestContext()?.actor;
  if (actor?.type !== type) throw new AppError('UNAUTHORIZED');
  return { type, id: actor.id };
}

/**
 * Reads and changes a person's inbox.
 *
 * Why: owner list E: staff, merchants and customers see their own notifications with a read state and an unread count. Every read and
 * write carries the owner's two keys, so another person's item is a 404, never a 403 (no existence leak). The answers are personal:
 * nothing here is cached.
 *
 * Side effects: `markRead` and `markAllRead` update `notification_inbox.read_at`; the rest only reads.
 *
 * @see GET /admin/inbox, GET /client/notifications, GET /store/v1/me/notifications
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly db: DbService,
    private readonly texts: InboxTextRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the owner's items, newest first, with their text in the reader's language.
   *
   * @param owner whose inbox
   * @param query the parsed request: category filter, sort, range, `unread` and `locale`
   * @returns the page and the exact total (items of a cancelled campaign are hidden)
   */
  async list(
    owner: InboxOwner,
    query: ParsedListQuery<'createdAt' | 'id', { unread?: 'true' | 'false'; locale?: 'en' | 'ar' }>,
  ): Promise<{ rows: WireInboxItem[]; total: number }> {
    const [{ rows, total }, recipient] = await Promise.all([
      listInboxRows(this.db.db, owner, query),
      recipientOf(this.db.db, owner.type, owner.id),
    ]);
    // `locale` is the page language of the reader; without it a customer reads their saved language, the others English.
    const reader = {
      audience: audienceOf(owner.type),
      locale: query.extra.locale ?? recipient?.locale ?? 'en',
      name: recipient?.name ?? '',
    };
    return { rows: rows.map((row) => inboxView(row, reader, this.texts)), total };
  }

  /**
   * Counts the owner's unread items.
   *
   * @param owner whose inbox
   * @returns the number, at most 100 (a client shows "99+" for 100)
   */
  async unread(owner: InboxOwner): Promise<{ unread: number }> {
    return { unread: await countUnread(this.db.db, owner) };
  }

  /**
   * Marks one item read.
   *
   * @param owner whose inbox
   * @param id the item
   * @throws {AppError} `NOT_FOUND` when the owner has no such item (another person's id included)
   */
  async markRead(owner: InboxOwner, id: number): Promise<void> {
    const result = await markItemRead(this.db.db, owner, id, this.clock.now());
    if (result === 'missing') throw new AppError('NOT_FOUND', { detail: 'There is no such notification.' });
  }

  /**
   * Marks the owner's unread items read.
   *
   * @param owner whose inbox
   * @param upToId only items up to this id (the newest the screen showed), or all
   * @returns how many items this call marked
   */
  async markAll(owner: InboxOwner, upToId: number | undefined): Promise<{ updated: number }> {
    return { updated: await markAllRead(this.db.db, owner, upToId, this.clock.now()) };
  }
}
