// CustomerDirectory as a module of its own: the support module imports it for its guest customers. It needs only the clock, so a test app
// built without a database keeps it, like the legal documents of the storefront module.
import { Module } from '@nestjs/common';
import { CustomerDirectory } from './application/customer-directory';

/**
 * Provides and exports {@link CustomerDirectory}.
 *
 * Why: `customers` belongs to this module, so support reaches it through this public service (decision 016); a separate module lets
 * support import the directory without the checkout or the sign-in routes.
 */
@Module({ providers: [CustomerDirectory], exports: [CustomerDirectory] })
export class CustomerDirectoryModule {}
