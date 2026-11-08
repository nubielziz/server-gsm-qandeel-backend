// The automatic credit must ask risk before it credits a top-up (RESOLUTIONS money-3). Both processes that can credit a top-up share
// one list of screening hooks with the risk module that fills it, and the worker (where the credit runs) loads the risk services.
// Checked on the module metadata, without a database.
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { PaymentAutoCreditModule, TopUpScreeningModule } from '../../src/modules/money';
import { RiskServicesModule } from '../../src/modules/risk';
import { WorkerModule } from '../../src/worker.module';

/** The modules a Nest module imports. */
const importsOf = (module: object): unknown[] =>
  (Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? [];

describe('the top-up screening wiring', () => {
  it('is loaded by the worker, where the automatic credit runs', () => {
    expect(importsOf(WorkerModule)).toContain(PaymentAutoCreditModule);
    expect(importsOf(WorkerModule)).toContain(RiskServicesModule);
  });

  it('shares one hook list between the automatic credit and the risk services', () => {
    expect(importsOf(PaymentAutoCreditModule)).toContain(TopUpScreeningModule);
    expect(importsOf(RiskServicesModule)).toContain(TopUpScreeningModule);
  });
});
