// HTTP controller of the customer inbox (feature 23, routes /store/v1/me/notifications, scripts/map-additions/23.mjs).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../../common/contract';
import {
  listCustomerInbox,
  customerUnreadCount,
  markCustomerInboxRead,
  markAllCustomerInboxRead,
} from './inbox.contracts';
import { InboxService, inboxOwner } from './inbox.service';

/**
 * The customer's own notifications.
 *
 * Why: owner list E: customers read order, payment and refund items and announcements in their account. Thin layer over {@link InboxService}; the person is the session's actor, never a parameter.
 *
 * @route GET /store/v1/me/notifications
 * @route GET /store/v1/me/notifications/unread-count
 * @route POST /store/v1/me/notifications/:id/read
 * @route POST /store/v1/me/notifications/read-all
 */
@Controller()
export class CustomerInboxController {
  constructor(private readonly inbox: InboxService) {}

  /**
   * Lists the person's notifications.
   *
   * @param query range, category, `unread` and `locale`
   * @returns the page
   * @route GET /store/v1/me/notifications
   */
  @Route(listCustomerInbox)
  list(@Query() query: QueryOf<typeof listCustomerInbox>): Promise<ResultOf<typeof listCustomerInbox>> {
    return this.inbox.list(inboxOwner('customer'), query);
  }

  /**
   * Counts the unread notifications.
   *
   * @returns the number, at most 100
   * @route GET /store/v1/me/notifications/unread-count
   */
  @Route(customerUnreadCount)
  unread(): Promise<ResultOf<typeof customerUnreadCount>> {
    return this.inbox.unread(inboxOwner('customer'));
  }

  /**
   * Marks one notification read.
   *
   * @param params the item id
   * @returns nothing (204)
   * @route POST /store/v1/me/notifications/:id/read
   */
  @Route(markCustomerInboxRead)
  read(@Param() params: ParamsOf<typeof markCustomerInboxRead>): Promise<void> {
    return this.inbox.markRead(inboxOwner('customer'), params.id);
  }

  /**
   * Marks the unread notifications read.
   *
   * @param body the optional newest id the screen showed
   * @returns how many were marked
   * @route POST /store/v1/me/notifications/read-all
   */
  @Route(markAllCustomerInboxRead)
  readAll(@Body() body: BodyOf<typeof markAllCustomerInboxRead>): Promise<ResultOf<typeof markAllCustomerInboxRead>> {
    return this.inbox.markAll(inboxOwner('customer'), body.upToId);
  }
}
