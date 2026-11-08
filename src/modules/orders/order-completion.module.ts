// The module that owns the one list of order completion listeners (feature 11): a leaf with no dependencies, so the API and the worker
// (which settles supplier results) both see the same instance and commissions can register in either process.
import { Global, Module } from '@nestjs/common';
import { OrderCompletionListeners } from './application/order-completion-listeners';

/**
 * Provides {@link OrderCompletionListeners}.
 *
 * Why: `OrderTransitions` and `OrderPlacement` live in two modules (the API's and the worker's engine) and each must call the same
 * list, so the list has its own module instead of being a provider of both. It needs nothing, so a test app built without a
 * database can load it. Global so that the commissions module registers without importing the orders internals.
 */
@Global()
@Module({ providers: [OrderCompletionListeners], exports: [OrderCompletionListeners] })
export class OrderCompletionModule {}
