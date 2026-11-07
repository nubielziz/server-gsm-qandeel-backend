// HTTP controller of the audit log routes (map domain G, /admin/audit-logs, stage 2). Read-only and thin.
import { Controller, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AuditLogAdminService } from '../application/audit-log-admin.service';
import { listAuditLogs, showAuditLog } from '../contracts/audit-logs.contracts';

/**
 * The audit log routes.
 *
 * Why: the console's audit page (RULES audit).
 *
 * @route GET /admin/audit-logs
 * @route GET /admin/audit-logs/:id
 */
@Controller()
export class AuditLogsController {
  constructor(private readonly audit: AuditLogAdminService) {}

  /**
   * Lists audit entries.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/audit-logs
   */
  @Route(listAuditLogs)
  list(@Query() query: QueryOf<typeof listAuditLogs>): Promise<ResultOf<typeof listAuditLogs>> {
    return this.audit.list(query);
  }

  /**
   * Shows one audit entry.
   *
   * @param params the entry id
   * @returns the entry
   * @route GET /admin/audit-logs/:id
   */
  @Route(showAuditLog)
  show(@Param() params: ParamsOf<typeof showAuditLog>): Promise<ResultOf<typeof showAuditLog>> {
    return this.audit.show(params.id);
  }
}
