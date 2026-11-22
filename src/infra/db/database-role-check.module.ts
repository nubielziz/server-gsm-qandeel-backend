// Nest module of the boot check of the application's database role (decision 055). Imported by the API's and the worker's root modules.
import { Module } from '@nestjs/common';
import { DatabaseRoleCheck } from './database-role-check';

/**
 * Provides {@link DatabaseRoleCheck}, which runs once when the process starts.
 *
 * Why: decision 055: both processes refuse to start in production when they connect as a superuser or as an owner of a table. Test apps
 * replace this module (`test/support/app.ts`): they connect as the test database's owner on purpose (one role, decision 014), and the
 * tests of the check call it themselves.
 *
 * Side effects: the check's read of the role at start (production only).
 */
@Module({ providers: [DatabaseRoleCheck], exports: [DatabaseRoleCheck] })
export class DatabaseRoleCheckModule {}
