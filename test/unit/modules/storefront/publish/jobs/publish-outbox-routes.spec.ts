// Unit tests of the bulk publish's outbox routes and of the modules that load them (feature 31, plan 31 section 6): the four events go
// to their exact queue and job, and both processes load the routes (each relay only knows the routes of its own process). The integration
// suite calls the runner directly, so a wrong job name or a module dropped from a root module is caught here only.
import { describe, expect, it } from 'bun:test';
import { AppModule } from '@src/app.module';
import { WorkerModule } from '@src/worker.module';
import { OutboxRouteRegistry } from '@src/modules/platform';
import { PublishEngineModule } from '@src/modules/storefront/publish/publish-engine.module';
import { PublishWorkerModule } from '@src/modules/storefront/publish/publish-worker.module';
import { PublishOutboxRoutes } from '@src/modules/storefront/publish/jobs/publish-outbox-routes';
import { PublishReconcilePass } from '@src/modules/storefront/publish/jobs/publish-reconcile';
import {
  PublishApplyProcessor,
  PublishFromQuickAddProcessor,
  PublishPrepareProcessor,
  PublishSetListedProcessor,
} from '@src/modules/storefront/publish/jobs/publish.processors';

const metadata = (key: string, module: object) => (Reflect.getMetadata(key, module) as unknown[] | undefined) ?? [];

describe('PublishOutboxRoutes', () => {
  it('routes the prepare, the apply, the run switch and the Quick add hand-over to their jobs on the imports queue', () => {
    const registry = new OutboxRouteRegistry();
    new PublishOutboxRoutes(registry).onModuleInit();
    expect(registry.get('storefront.publish_prepare')).toEqual({
      type: 'storefront.publish_prepare',
      queue: 'imports',
      jobName: 'publish_prepare',
    });
    expect(registry.get('storefront.publish_apply')).toEqual({
      type: 'storefront.publish_apply',
      queue: 'imports',
      jobName: 'publish_apply',
    });
    expect(registry.get('storefront.publish_set_listed')).toEqual({
      type: 'storefront.publish_set_listed',
      queue: 'imports',
      jobName: 'publish_set_listed',
    });
    expect(registry.get('supplier.quick_add_done')).toEqual({
      type: 'supplier.quick_add_done',
      queue: 'imports',
      jobName: 'publish_from_quick_add',
    });
  });

  it('is loaded by the API and, with the processors, by the worker', () => {
    expect(metadata('providers', PublishEngineModule)).toContain(PublishOutboxRoutes);
    expect(metadata('imports', AppModule)).toContain(PublishEngineModule);
    expect(metadata('imports', WorkerModule)).toContain(PublishWorkerModule);
    expect(metadata('imports', PublishWorkerModule)).toContain(PublishEngineModule);
    expect(metadata('providers', PublishWorkerModule)).toEqual([
      PublishPrepareProcessor,
      PublishApplyProcessor,
      PublishSetListedProcessor,
      PublishFromQuickAddProcessor,
      // Decision 055: the lost-work pass of the runs, worker only.
      PublishReconcilePass,
    ]);
  });

  it('keeps the processors out of the API, which never runs a job', () => {
    expect(metadata('providers', PublishEngineModule)).not.toContain(PublishApplyProcessor);
    expect(metadata('imports', AppModule)).not.toContain(PublishWorkerModule);
  });
});
