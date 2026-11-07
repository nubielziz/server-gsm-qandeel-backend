// The per-IP rate limit stage of the request pipeline (decision 021): public store routes, sign-in routes and token routes are
// counted per client IP before authentication; a refusal is 429 RATE_LIMITED with Retry-After.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { contractRegistry } from '../../common/contract';
import { ipRateLimitKey, parseIpAddress } from '../../common/ip-address';
import { RequestPipeline, requestPath } from '../../common/pipeline';
import { isLargeBody, publicLimiterFor } from './public-ip-limit';
import { RateLimitService } from './rate-limit.service';

/**
 * Registers the per-IP rate limit stage with the pipeline.
 *
 * Why: the third check before authentication (decision 018): after the IP rules and maintenance, the public surfaces are
 * counted per client address with the `ip`, `token` and `upload` limiters of `limiters.ts` (the numbers live there, nowhere
 * else). The key is the IPv4 address or the /64 network of an IPv6 address, so rotating addresses inside one subscriber's
 * network does not dodge the limit. If the cache Redis is down, the limiter counts in memory per process (decision 021).
 *
 * Side effects: one point on `gsm:{env}:ratelimit:{ip|token}:{client}` per counted request; `rate_limit_denied_total`.
 *
 * @throws {AppError} `RATE_LIMITED` (429, `Retry-After` in seconds) when the budget is used up
 */
@Injectable()
export class PublicIpLimitHook implements OnModuleInit {
  constructor(
    private readonly pipeline: RequestPipeline,
    private readonly limits: RateLimitService,
  ) {}

  /** Registers the stage. */
  onModuleInit(): void {
    this.pipeline.register('rate-limit', (request) => this.handle(request));
  }

  /**
   * Counts one request when it is on a limited public route.
   *
   * @param request the request
   * @throws {AppError} `RATE_LIMITED` when the client is over the limit
   */
  async handle(request: FastifyRequest): Promise<void> {
    const template = request.routeOptions?.url;
    // Fastify answers HEAD from the GET route: it has the access of the GET contract (a HEAD flood must not dodge `token`).
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const access = template ? contractRegistry.get(`${method} ${template}`)?.access : undefined;
    const largeBody = isLargeBody(request.headers['content-type'], request.headers['content-length']);
    const limiter = publicLimiterFor(requestPath(request), access, largeBody);
    if (!limiter) return;
    await this.limits.enforce(limiter, ipRateLimitKey(parseIpAddress(request.ip)));
  }
}
