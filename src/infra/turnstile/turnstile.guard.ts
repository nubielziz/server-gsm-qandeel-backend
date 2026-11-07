// The Turnstile guard of decision 034: for a `turnstile: true` route it checks the X-Turnstile-Token header after authentication.
import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Counter } from 'prom-client';
import { getContract } from '../../common/contract';
import { AppError } from '../../common/errors';
import { getRequestId } from '../../common/request-id';
import { MetricsService } from '../metrics';
import {
  TURNSTILE_HEADER,
  TURNSTILE_MAX_TOKEN_LENGTH,
  TURNSTILE_VERIFIER,
  type TurnstileFailureReason,
  type TurnstileVerifier,
} from './turnstile-verifier';

/** What the visitor is told when the check fails: never why. */
const REFUSAL_DETAIL = 'The anti-bot check failed. Refresh the page and try again.';

/**
 * Refuses a storefront write whose anti-bot token is missing or bad.
 *
 * Why: decision 034: three storefront features (14a, 14b, 17) need the same check, so it is one guard driven by the route
 * contract (`turnstile: true`). `AccessGuard` calls it after authentication, CSRF and permission checks; the per-IP limit hook of
 * decision 021 has already run, so an outbound verification only happens inside the limits. A missing, empty, repeated or
 * over-long token is refused without an outbound call; otherwise the verifier decides. The refusal is always `403
 * TURNSTILE_FAILED` with one fixed detail; the log has the request id and the reason (and Cloudflare's error codes), never the
 * token, and `turnstile_failures_total{reason}` counts it.
 *
 * Side effects: possibly one outbound call (through the verifier); a counter; a warning log line per refusal.
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  private readonly logger = new Logger(TurnstileGuard.name);
  private readonly failures: Counter<'reason'>;

  constructor(
    @Inject(TURNSTILE_VERIFIER) private readonly verifier: TurnstileVerifier,
    metrics: MetricsService,
  ) {
    this.failures = new Counter({
      name: 'turnstile_failures_total',
      help: 'Storefront writes refused by the anti-bot check, by reason (missing, too_long, rejected, hostname, timeout, network, bad_response).',
      labelNames: ['reason'],
      registers: [metrics.registry],
    });
  }

  /**
   * Checks the token of a route that asks for it.
   *
   * @param context the request being handled
   * @returns true when the route has no `turnstile` flag or the token is good
   * @throws {AppError} `TURNSTILE_FAILED` (403) when the token is missing, malformed, too long, refused or could not be checked
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const contract = getContract(context.getHandler());
    if (!contract?.turnstile) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const header = request.headers[TURNSTILE_HEADER];
    // A repeated header arrives as an array: ambiguous, so refused like a missing one.
    const token = typeof header === 'string' ? header.trim() : '';
    if (token === '') throw this.refuse('missing');
    if (token.length > TURNSTILE_MAX_TOKEN_LENGTH) throw this.refuse('too_long');

    const verdict = await this.verifier.verify(token, request.ip);
    if (!verdict.ok) throw this.refuse(verdict.reason, verdict.errorCodes);
    return true;
  }

  private refuse(reason: TurnstileFailureReason, errorCodes: readonly string[] = []): AppError {
    this.failures.inc({ reason });
    this.logger.warn({ msg: 'Turnstile check failed', reason, errorCodes, requestId: getRequestId() });
    return new AppError('TURNSTILE_FAILED', { detail: REFUSAL_DETAIL });
  }
}
