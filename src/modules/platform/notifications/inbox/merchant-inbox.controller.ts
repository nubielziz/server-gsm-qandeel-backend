// HTTP controller of the merchant inbox (feature 23, routes /client/notifications, scripts/map-additions/23.mjs).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../../common/contract';
import {
  listMerchantInbox,
  merchantUnreadCount,
  markMerchantInboxRead,
  markAllMerchantInboxRead,
} from './inbox.contracts';
import { InboxService, inboxOwner } from './inbox.service';

/**
 * The merchant's own notifications.
 *
 * Why: owner list E: merchants read announcements, low-balance and paid-invoice items in the portal; a merchant waiting for approval may read too. Thin layer over {@link InboxService}; the person is the session's actor, never a parameter.
 *
 * @route GET /client/notifications
 * @route GET /client/notifications/unread-count
 * @route POST /client/notifications/:id/read
 * @route POST /client/notifications/read-all
 */
@Controller()
export class MerchantInboxController {
  constructor(private readonly inbox: InboxService) {}

  /**
   * Lists the person's notifications.
   *
   * @param query range, category, `unread` and `locale`
   * @returns the page
   * @route GET /client/notifications
   */
  @Route(listMerchantInbox)
  list(@Query() query: QueryOf<typeof listMerchantInbox>): Promise<ResultOf<typeof listMerchantInbox>> {
    return this.inbox.list(inboxOwner('client'), query);
  }

  /**
   * Counts the unread notifications.
   *
   * @returns the number, at most 100
   * @route GET /client/notifications/unread-count
   */
  @Route(merchantUnreadCount)
  unread(): Promise<ResultOf<typeof merchantUnreadCount>> {
    return this.inbox.unread(inboxOwner('client'));
  }

  /**
   * Marks one notification read.
   *
   * @param params the item id
   * @returns nothing (204)
   * @route POST /client/notifications/:id/read
   */
  @Route(markMerchantInboxRead)
  read(@Param() params: ParamsOf<typeof markMerchantInboxRead>): Promise<void> {
    return this.inbox.markRead(inboxOwner('client'), params.id);
  }

  /**
   * Marks the unread notifications read.
   *
   * @param body the optional newest id the screen showed
   * @returns how many were marked
   * @route POST /client/notifications/read-all
   */
  @Route(markAllMerchantInboxRead)
  readAll(@Body() body: BodyOf<typeof markAllMerchantInboxRead>): Promise<ResultOf<typeof markAllMerchantInboxRead>> {
    return this.inbox.markAll(inboxOwner('client'), body.upToId);
  }
}
