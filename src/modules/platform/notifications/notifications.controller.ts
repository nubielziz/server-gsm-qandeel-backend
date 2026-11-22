// HTTP controller of the notification log (map domain G, stage 12, routes /admin/notifications).
import { Controller, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { identityApi } from './identity-api';
import { NOTIFICATION_PAYLOAD_PERMISSION, NotificationLogAdminService } from './notification-log-admin.service';
import { listNotificationLog, showNotificationLog } from './notification-log.contracts';

/**
 * Routes of the notification log.
 *
 * Why: thin layer over {@link NotificationLogAdminService}; the log is read only. The single read tells the service whether the caller
 * holds `notifications:*` (decision 054) and the list what the caller may see of customers' addresses (decision 047), both read through
 * identity's helpers loaded late (decision 032 amendment); a request without a staff principal gets the least view of each.
 */
@Controller()
export class NotificationsController {
  constructor(private readonly log: NotificationLogAdminService) {}

  /**
   * Lists the log.
   *
   * @param query range, sort, filters and search
   * @param request the request, which carries the caller (decision 047: a customer's address is searched only for callers who hold `customers:read`)
   * @returns the page of rows
   * @route GET /admin/notifications
   */
  @Route(listNotificationLog)
  async list(
    @Query() query: QueryOf<typeof listNotificationLog>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof listNotificationLog>> {
    // The platform module imports no other module (decision 032): identity's helpers are loaded late (the module-level cycle).
    const identity = await identityApi();
    const principal = identity.principalOf(request);
    // A request without a staff principal gets the least view (the route's guard keeps such a request out).
    return this.log.list(query, principal?.kind === 'staff' ? identity.customerContactOf(principal) : 'masked');
  }

  /**
   * Reads one notification.
   *
   * @param params the notification id
   * @param request the request (its staff principal decides whether the payload's values are shown)
   * @returns the entry with its payload
   * @route GET /admin/notifications/:id
   */
  @Route(showNotificationLog)
  async show(
    @Param() params: ParamsOf<typeof showNotificationLog>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof showNotificationLog>> {
    const identity = await identityApi();
    const principal = identity.principalOf(request);
    // Decision 054: the payload's values are shown to the holders of the whole notifications area only.
    const fullPayload =
      principal?.kind === 'staff' && identity.grants(principal.permissions, NOTIFICATION_PAYLOAD_PERMISSION);
    return this.log.get(params.id, { fullPayload });
  }
}
