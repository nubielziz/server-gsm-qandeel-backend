// The worker side of the bulk publish (feature 31, plan 31 section 6): the processors of the `imports` queue. Import it in the worker
// process only (src/worker.module.ts).
import { Module } from '@nestjs/common';
import {
  PublishApplyProcessor,
  PublishFromQuickAddProcessor,
  PublishPrepareProcessor,
  PublishSetListedProcessor,
} from './jobs/publish.processors';
import { PublishEngineModule } from './publish-engine.module';

/**
 * Provides the processors of `publish_prepare`, `publish_apply`, `publish_set_listed` and `publish_from_quick_add`.
 *
 * Why: decision 020: the API only moves a run and writes its event; the worker does the work. `QueueWorkers` finds the processors and
 * closes its BullMQ workers in `onModuleDestroy`, before the connections close.
 *
 * @see docs/queues.md (imports)
 */
@Module({
  imports: [PublishEngineModule],
  providers: [PublishPrepareProcessor, PublishApplyProcessor, PublishSetListedProcessor, PublishFromQuickAddProcessor],
})
export class PublishWorkerModule {}
