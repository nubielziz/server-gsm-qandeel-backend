// Catalog & pricing module (map domain B): groups, categories, services, fields, prices, pricing rules, inventory, TAC.
// Empty shell in P2.1; its feature adds controllers, services and the owned tables (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';

/**
 * Nest module for Catalog & pricing (map domain B).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016).
 */
@Module({})
export class CatalogModule {}
