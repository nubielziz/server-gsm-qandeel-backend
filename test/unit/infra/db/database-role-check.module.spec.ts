// The boot check of the application's database role must run in every production process (decision 055): the API and the worker both
// import its module, and the module provides the check. Checked on the module metadata, without a database: a root module that loses
// the import would start in production with any role, silently.
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { AppModule } from '@src/app.module';
import { DatabaseRoleCheck, DatabaseRoleCheckModule } from '@src/infra/db';
import { WorkerModule } from '@src/worker.module';

/** What a Nest module lists under a metadata key (imports, providers). */
const listed = (key: string, module: object): unknown[] =>
  (Reflect.getMetadata(key, module) as unknown[] | undefined) ?? [];

describe('the database role check wiring', () => {
  it('is imported by the API', () => {
    expect(listed('imports', AppModule)).toContain(DatabaseRoleCheckModule);
  });

  it('is imported by the worker', () => {
    expect(listed('imports', WorkerModule)).toContain(DatabaseRoleCheckModule);
  });

  it('provides the check that runs at start', () => {
    expect(listed('providers', DatabaseRoleCheckModule)).toContain(DatabaseRoleCheck);
    expect(listed('exports', DatabaseRoleCheckModule)).toContain(DatabaseRoleCheck);
  });
});
