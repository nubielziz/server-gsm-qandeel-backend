// Nest guard for GET /metrics ("internal-or-token" access in the map): answers 403 FORBIDDEN unless allowed.
// The guard dispatcher (identity module, P2.5a) runs this rule for every route with access `internal-or-token`; the
// controller keeps its own @UseGuards as well, because /metrics has its own rule.
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors/app-error';
import { APP_CONFIG, type AppConfig } from '../../config';
import { authorizeMetricsRequest, hasForwardingHeaders } from './metrics-access';

/**
 * Allows a request to read `/metrics` only from the internal network or with `Authorization: Bearer <METRICS_TOKEN>`.
 *
 * Why: metrics reveal routes, traffic and error rates; the map restricts them to the internal network or a token.
 *
 * @route GET /metrics
 * @throws {AppError} `FORBIDDEN` (403) when the caller is neither internal nor holds the token
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Decides whether the caller may read the metrics.
   *
   * @param context the request being handled
   * @returns true when the caller is internal or sent the token
   * @throws {AppError} `FORBIDDEN` (403) otherwise
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const allowed = authorizeMetricsRequest(
      {
        authorization: request.headers.authorization,
        remoteAddress: request.ip,
        forwarded: hasForwardingHeaders(request.headers),
      },
      this.config.observability.metricsToken,
    );
    if (!allowed) {
      throw new AppError('FORBIDDEN', {
        detail: this.config.observability.metricsToken
          ? 'Send the metrics token as "Authorization: Bearer <token>".'
          : 'Metrics are only available from the internal network.',
      });
    }
    return true;
  }
}
