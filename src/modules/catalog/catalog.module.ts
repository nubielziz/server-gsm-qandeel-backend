// Catalog & pricing module (map domain B): groups, categories, services, fields, prices, pricing rules, inventory, TAC.
// It provides the read-only ClientGroupDirectory; the admin routes of the catalog's structure are CatalogAdminModule
// (docs/ARCHITECTURE.md § 2).
import { Global, Module } from '@nestjs/common';
import { ClientGroupDirectory } from './application/client-group-directory';

/**
 * Nest module for Catalog & pricing (map domain B).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). It is global so identity (merchant creation, group moves, the promotion job) can inject the directory without
 * importing the module. It imports nothing that leads back into identity (the admin routes are `CatalogAdminModule`, which the
 * root module imports next to this one), so identity can import `CatalogModule` while it is still loading (decision 032).
 */
@Global()
@Module({ providers: [ClientGroupDirectory], exports: [ClientGroupDirectory] })
export class CatalogModule {}
