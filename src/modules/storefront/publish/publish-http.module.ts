// The HTTP side of the bulk publish (feature 31, plan 31 section 5.2): the staff routes of a run and its draft and the use cases they call.
// API only; both processes load the engine (PublishEngineModule), the worker adds the processors.
import { Module } from '@nestjs/common';
import { PublishItemEditService } from './application/publish-item-edit.service';
import { PublishRunAdminService } from './application/publish-run-admin.service';
import { PublishRunActionsController } from './controllers/publish-run-actions.controller';
import { PublishRunsController } from './controllers/publish-runs.controller';
import { PublishEngineModule } from './publish-engine.module';

/**
 * Provides `/admin/publish-runs` (create, list, show and the rows of a run; edit a row, change many, apply, cancel and switch).
 *
 * Why: these use cases need the global database, audit and clock providers and the outbox, which a database-less test app does not
 * have, so the module is separate (and replaced there), like the search routes. The preparing and applying engine is the imported
 * {@link PublishEngineModule}, which the worker loads too.
 */
@Module({
  imports: [PublishEngineModule],
  controllers: [PublishRunsController, PublishRunActionsController],
  providers: [PublishItemEditService, PublishRunAdminService],
})
export class PublishHttpModule {}
