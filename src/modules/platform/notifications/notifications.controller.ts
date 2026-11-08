// HTTP controller of the notification log (map domain G, stage 12, routes /admin/notifications).
import { Controller, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { NotificationLogAdminService } from './notification-log-admin.service';
import { listNotificationLog, showNotificationLog } from './notification-log.contracts';

/**
 * Routes of the notification log.
 *
 * Why: thin layer over {@link NotificationLogAdminService}; the log is read only.
 */
@Controller()
export class NotificationsController {
  constructor(private readonly log: NotificationLogAdminService) {}

  /**
   * Lists the log.
   *
   * @param query range, sort, filters and search
   * @returns the page of rows
   * @route GET /admin/notifications
   */
  @Route(listNotificationLog)
  list(@Query() query: QueryOf<typeof listNotificationLog>): Promise<ResultOf<typeof listNotificationLog>> {
    return this.log.list(query);
  }

  /**
   * Reads one notification.
   *
   * @param params the notification id
   * @returns the entry with its payload
   * @route GET /admin/notifications/:id
   */
  @Route(showNotificationLog)
  show(@Param() params: ParamsOf<typeof showNotificationLog>): Promise<ResultOf<typeof showNotificationLog>> {
    return this.log.get(params.id);
  }
}
