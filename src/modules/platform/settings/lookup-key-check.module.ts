// Nest module of the boot check of LOOKUP_HASH_KEY (platform module, decision 054). Imported by the API's and the worker's root modules.
import { Module } from '@nestjs/common';
import { LookupKeyCheck } from './lookup-key-check';

/**
 * Provides {@link LookupKeyCheck}, which runs once when the process starts.
 *
 * Why: decision 054: both processes refuse to start in production with a `LOOKUP_HASH_KEY` that differs from the key
 * the stored lookups were made with. Test apps replace this module (`test/support/app.ts`): one test database serves apps of several
 * keys, and the tests of the check call it themselves.
 *
 * Side effects: the check's write of its marker at start.
 */
@Module({ providers: [LookupKeyCheck], exports: [LookupKeyCheck] })
export class LookupKeyCheckModule {}
