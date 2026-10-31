// Nest module of the per-IP rate limit stage (decision 021). Import it in the API's root module only: the worker has no
// HTTP pipeline.
import { Module } from '@nestjs/common';
import { PublicIpLimitHook } from './public-ip-limit.hook';

/**
 * Registers the per-IP rate limit stage with the request pipeline.
 *
 * Why: the limiter service is shared by the API and the worker (`RateLimitModule`), but the HTTP stage belongs to the API
 * only. It needs the global pipeline and rate-limit modules.
 */
@Module({ providers: [PublicIpLimitHook] })
export class PublicIpLimitModule {}
