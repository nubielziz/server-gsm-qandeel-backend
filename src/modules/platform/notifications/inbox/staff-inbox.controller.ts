// HTTP controller of the staff-member inbox (feature 23, routes /admin/inbox, scripts/map-additions/23.mjs).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../../common/contract';
import { listStaffInbox, staffUnreadCount, markStaffInboxRead, markAllStaffInboxRead } from './inbox.contracts';
import { InboxService, inboxOwner } from './inbox.service';

/**
 * The staff-member's own notifications.
 *
 * Why: owner list E: staff see the notices staff sent them (broadcasts, test messages) in the console's bell. Thin layer over {@link InboxService}; the person is the session's actor, never a parameter.
 *
 * @route GET /admin/inbox
 * @route GET /admin/inbox/unread-count
 * @route POST /admin/inbox/:id/read
 * @route POST /admin/inbox/read-all
 */
@Controller()
export class StaffInboxController {
  constructor(private readonly inbox: InboxService) {}

  /**
   * Lists the person's notifications.
   *
   * @param query range, category and `unread`
   * @returns the page
   * @route GET /admin/inbox
   */
  @Route(listStaffInbox)
  list(@Query() query: QueryOf<typeof listStaffInbox>): Promise<ResultOf<typeof listStaffInbox>> {
    return this.inbox.list(inboxOwner('staff'), query);
  }

  /**
   * Counts the unread notifications.
   *
   * @returns the number, at most 100
   * @route GET /admin/inbox/unread-count
   */
  @Route(staffUnreadCount)
  unread(): Promise<ResultOf<typeof staffUnreadCount>> {
    return this.inbox.unread(inboxOwner('staff'));
  }

  /**
   * Marks one notification read.
   *
   * @param params the item id
   * @returns nothing (204)
   * @route POST /admin/inbox/:id/read
   */
  @Route(markStaffInboxRead)
  read(@Param() params: ParamsOf<typeof markStaffInboxRead>): Promise<void> {
    return this.inbox.markRead(inboxOwner('staff'), params.id);
  }

  /**
   * Marks the unread notifications read.
   *
   * @param body the optional newest id the screen showed
   * @returns how many were marked
   * @route POST /admin/inbox/read-all
   */
  @Route(markAllStaffInboxRead)
  readAll(@Body() body: BodyOf<typeof markAllStaffInboxRead>): Promise<ResultOf<typeof markAllStaffInboxRead>> {
    return this.inbox.markAll(inboxOwner('staff'), body.upToId);
  }
}
