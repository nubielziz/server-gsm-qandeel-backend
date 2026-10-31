// Global module that gives every part of a process the same MetricsService (one registry per process, decision 015).
import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Provides the process-wide {@link MetricsService}.
 *
 * Why: the exception filter, the HTTP hook, the health module's `/metrics` route and (later) queue gauges all write
 * into one registry.
 */
@Global()
@Module({ providers: [MetricsService], exports: [MetricsService] })
export class MetricsModule {}
