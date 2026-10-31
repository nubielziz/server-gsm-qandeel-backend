// Identity & access module (map domain A): staff, roles, merchants, sessions, auth tokens, API keys, KYC, IP rules.
// Empty shell in P2.1; its feature adds controllers, services and the owned tables (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';

/**
 * Nest module for Identity & access (map domain A).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016).
 */
@Module({})
export class IdentityModule {}
