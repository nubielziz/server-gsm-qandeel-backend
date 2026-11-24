// The module that owns the one list of account erasure hooks (feature 18; one account type, decision 064): a leaf with no dependencies,
// so the support module and the notification center can register their hooks without importing the customers internals.
import { Global, Module } from '@nestjs/common';
import { AccountErasureHooks } from './application/customer-erasure-hooks';

/**
 * Provides {@link AccountErasureHooks}.
 *
 * Why: the customers module runs the hooks when it anonymizes an account; the modules that hold data about the account register
 * theirs (the inbox, the support tickets). It needs nothing, so a test app built without a database can load it. Global so that
 * registering needs no import. The API and the worker load it.
 */
@Global()
@Module({ providers: [AccountErasureHooks], exports: [AccountErasureHooks] })
export class CustomerErasureModule {}
