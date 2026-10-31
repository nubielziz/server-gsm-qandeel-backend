// Public API of the rate-limit infrastructure (decision 021): the module, the service, the limiter table and the semaphore.
export { RateLimitModule } from './rate-limit.module';
export { RateLimitService, rateLimitedError } from './rate-limit.service';
export type { RateLimitOptions, RateLimitResult } from './rate-limit.service';
export { RATE_LIMITERS } from './limiters';
export type { LimiterConfig, LimiterName } from './limiters';
export { acquireSemaphore, releaseSemaphore } from './semaphore';
export type { SemaphoreLease } from './semaphore';
