// The sign-in lock of decision 052 as a module of its own: the console's, the merchant portal's and the storefront's sign-in use it,
// and it needs only the global providers (Redis, cache keys, token hashing, the clock, the database).
import { Module } from '@nestjs/common';
import { SignInLock } from './application/sign-in-lock';
import { SignInFailures } from './infra/sign-in-failures';

/**
 * Provides and exports {@link SignInLock}.
 *
 * Why: the customers module signs customers in and sets their passwords, so it reaches the lock through this public service; one module
 * instance means one in-process fallback for the whole API process while the cache Redis is down.
 */
@Module({ providers: [SignInFailures, SignInLock], exports: [SignInLock] })
export class SignInLockModule {}
