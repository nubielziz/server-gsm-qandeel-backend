// Public API of the rate-limit infrastructure (decision 021): the module, the service, the limiter table, the semaphore and
// the per-IP stage of the request pipeline.
export { RateLimitModule } from './rate-limit.module';
export { PublicIpLimitModule } from './public-ip-limit.module';
export { publicLimiterFor } from './public-ip-limit';
export { RateLimitService, rateLimitedError } from './rate-limit.service';
export type { RateLimitOptions, RateLimitResult } from './rate-limit.service';
export { RATE_LIMITERS } from './limiters';
export type { LimiterConfig, LimiterName } from './limiters';
export { acquireSemaphore, releaseSemaphore } from './semaphore';
export type { SemaphoreLease } from './semaphore';
