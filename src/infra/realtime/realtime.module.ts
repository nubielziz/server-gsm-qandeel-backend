// The real-time layer every process loads (decision 037): the doorbell publisher and the registry of sources. Global, so a use case
// in any module rings a doorbell and a module with live data registers its source.
import { Global, Module } from '@nestjs/common';
import { RealtimePublisher } from './realtime-publisher';
import { RealtimeSources } from './realtime-sources';

/**
 * Provides {@link RealtimePublisher} and {@link RealtimeSources} to every module of the API and the worker.
 *
 * Why: decision 037: the API and the worker both publish doorbells after their commits (an inbox item made by a worker job reaches
 * a stream at once); only the API holds streams (`RealtimeHubModule`). Needs the global Redis, metrics, clock and config.
 */
@Global()
@Module({
  providers: [RealtimePublisher, RealtimeSources],
  exports: [RealtimePublisher, RealtimeSources],
})
export class RealtimeModule {}
