// The commission engine must be loaded by every process in which an order can complete (feature 11): the API (staff replies, stock
// deliveries) and the worker (supplier results). Both processes must share one list of order completion listeners with the orders
// engine that makes the transition, or an accrual would be silently missed. Checked on the module metadata, without a database.
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { CommissionsAdminModule, CommissionsEngineModule } from '../../src/modules/commissions';
import { OrderCompletionModule, OrdersEngineModule } from '../../src/modules/orders';
import { WorkerModule } from '../../src/worker.module';

/** The modules a Nest module imports. */
const importsOf = (module: object): unknown[] =>
  (Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? [];

describe('the commission engine wiring', () => {
  it('is loaded by the worker, where the supplier results settle orders', () => {
    expect(importsOf(WorkerModule)).toContain(CommissionsEngineModule);
  });

  it("is loaded by the API through the commissions routes' module", () => {
    expect(importsOf(CommissionsAdminModule)).toContain(CommissionsEngineModule);
  });

  it('shares one completion listener list with the orders engine of the worker', () => {
    expect(importsOf(CommissionsEngineModule)).toContain(OrderCompletionModule);
    expect(importsOf(OrdersEngineModule)).toContain(OrderCompletionModule);
  });
});
