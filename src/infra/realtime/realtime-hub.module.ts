// The hub of the live streams (decision 037): API process only. The stream routes (identity) and feature 28's ticket stream use it.
import { Module } from '@nestjs/common';
import { RealtimeHub } from './realtime-hub';

/**
 * Provides the {@link RealtimeHub}: one doorbell subscriber and the open streams of this API process.
 *
 * Why: the worker publishes but holds no stream, so it never loads this module (and opens no subscriber connection). Needs the
 * global `RealtimeModule`, Redis, rate-limit, metrics, clock and config modules.
 */
@Module({
  providers: [RealtimeHub],
  exports: [RealtimeHub],
})
export class RealtimeHubModule {}
