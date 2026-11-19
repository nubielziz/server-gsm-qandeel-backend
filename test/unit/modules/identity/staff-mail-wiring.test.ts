// The staff link mails must be loaded by every process that writes or handles them (feature 20, slice C): the API writes the outbox events
// (through the access routes' module) and the worker handles them. Without the worker import the events would stay `unmapped_type`.
// Checked on the module metadata, without a database.
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { AccessAdminModule, IdentityMailEventsModule, StaffMailModule } from '@src/modules/identity';
import { WorkerModule } from '@src/worker.module';

/** The modules a Nest module imports. */
const importsOf = (module: object): unknown[] =>
  (Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? [];

describe('the staff mail wiring', () => {
  it('is loaded by the worker, which handles staff.invited and staff.password_reset', () => {
    expect(importsOf(WorkerModule)).toContain(StaffMailModule);
  });

  it("is loaded by the API through the staff routes' module", () => {
    expect(importsOf(AccessAdminModule)).toContain(StaffMailModule);
  });

  it('registers the identity notification events in both processes', () => {
    expect(importsOf(StaffMailModule)).toContain(IdentityMailEventsModule);
  });
});
