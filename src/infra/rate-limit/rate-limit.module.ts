// Global Nest module for rate limiting (decision 021): RateLimitService. Shared by the API and the worker.
import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/**
 * Provides {@link RateLimitService} to every module.
 *
 * Why: the request pipeline (per IP, per API key, sign-in) and the supplier jobs (rate and concurrency) share one limiter
 * service and one place for the numbers (decision 021). It needs the global Redis, cache-key and metrics providers.
 */
@Global()
@Module({ providers: [RateLimitService], exports: [RateLimitService] })
export class RateLimitModule {}
