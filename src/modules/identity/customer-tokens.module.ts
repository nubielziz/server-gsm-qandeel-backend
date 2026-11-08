// The one-time links of storefront customers (decision 019) as a module of their own: the customers module's sign-in routes,
// admin routes and mail job use it, and it needs only the database, the token hasher and the clock.
import { Module } from '@nestjs/common';
import { CustomerAuthTokens } from './application/customer-auth-tokens';

/**
 * Provides and exports {@link CustomerAuthTokens}.
 *
 * Why: `auth_tokens` belongs to identity, so customers reach it through this public service; a separate module lets the worker
 * (the customer mail job) load it without the security stack.
 */
@Module({ providers: [CustomerAuthTokens], exports: [CustomerAuthTokens] })
export class CustomerTokensModule {}
