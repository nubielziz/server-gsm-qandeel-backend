// The module that owns the one list of customer erasure hooks (feature 18): a leaf with no dependencies, so the support module can
// register its hook without importing the customers internals.
import { Global, Module } from '@nestjs/common';
import { CustomerErasureHooks } from './application/customer-erasure-hooks';

/**
 * Provides {@link CustomerErasureHooks}.
 *
 * Why: the customers module runs the hooks when it anonymizes a customer; the modules that hold data about the customer register
 * theirs. It needs nothing, so a test app built without a database can load it. Global so that registering needs no import.
 */
@Global()
@Module({ providers: [CustomerErasureHooks], exports: [CustomerErasureHooks] })
export class CustomerErasureModule {}
