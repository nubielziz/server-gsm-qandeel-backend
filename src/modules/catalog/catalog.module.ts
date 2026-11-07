// Catalog & pricing module (map domain B): groups, categories, services, fields, prices, pricing rules, inventory, TAC.
// Today it only provides the read-only ClientGroupDirectory; its feature adds controllers, services and the owned tables
// (docs/ARCHITECTURE.md § 2).
import { Global, Module } from '@nestjs/common';
import { ClientGroupDirectory } from './application/client-group-directory';

/**
 * Nest module for Catalog & pricing (map domain B).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). It is global so identity (merchant creation and group moves) can inject the directory without importing
 * the module.
 */
@Global()
@Module({ providers: [ClientGroupDirectory], exports: [ClientGroupDirectory] })
export class CatalogModule {}
