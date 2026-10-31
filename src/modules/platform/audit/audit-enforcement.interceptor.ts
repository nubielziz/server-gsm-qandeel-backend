// Checks that every staff write wrote an audit row (platform module, decision 018): a request-level safety net, because a
// forgotten AuditService.record would otherwise leave an admin action out of the log without anyone noticing.
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, tap } from 'rxjs';
import { getContract } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { getRequestContext } from '../../../common/request-context';
import { APP_CONFIG, type AppConfig } from '../../../config';

/**
 * Fails (or logs) a successful staff mutation that wrote no audit row.
 *
 * Why: "every admin write writes audit_logs" (CLAUDE.md). The check applies to every route whose contract is not a GET and
 * does not say `audit: false`, when the caller is a signed-in staff member. In development and tests the request fails with
 * `500` and a log line that names the route, so the missing `AuditService.record(tx, ...)` is found by the first test of the
 * use case. In production the change is already committed, so failing the request would only confuse the console: the
 * problem is logged as an error for the alerts instead.
 *
 * Side effects: logs an error line; in development and tests it replaces the answer of the request with a 500.
 */
@Injectable()
export class AuditEnforcementInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditEnforcementInterceptor.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Wraps the handler: after it succeeded, a staff mutation must have written an audit row.
   *
   * @param context the request being handled
   * @param next the rest of the pipeline, ending in the handler
   * @returns the handler's stream, which errors when the audit row is missing (outside production)
   * @throws {AppError} `INTERNAL_ERROR` (500) when a staff mutation wrote no audit row and the app is not in production
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const contract = getContract(context.getHandler());
    if (!contract || contract.method === 'GET' || !contract.audit) return next.handle();
    return next.handle().pipe(
      tap(() => {
        const request = getRequestContext();
        if (request?.actor?.type !== 'staff' || request.auditRecords > 0) return;
        const message = `${contract.key} changed data for a staff member but wrote no audit row. Call AuditService.record(tx, ...) in the use case, or declare audit: false on the contract and say why in its description.`;
        this.logger.error(message);
        if (!this.config.isProduction) throw new AppError('INTERNAL_ERROR', { detail: message });
      }),
    );
  }
}
