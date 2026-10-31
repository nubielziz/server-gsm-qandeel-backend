// Identity & access module (map domain A): staff, roles, merchants, sessions, auth tokens, API keys, KYC, IP rules.
// It owns the authentication and authorization building blocks (src/modules/identity/security) and the IP rules stage
// of the request pipeline (security/ip-rules); the sign-in routes and the staff, role and IP-rule routes arrive with
// their features (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';
import { IpRulesModule } from './security/ip-rules/ip-rules.module';
import { SecurityModule } from './security/security.module';

/**
 * Nest module for Identity & access (map domain A).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). Today it provides the security stack (sessions, CSRF, permissions and the guard dispatcher) and,
 * through `IpRulesModule`, the IP rules stage of the request pipeline (scenario ip-rules).
 */
@Module({ imports: [SecurityModule, IpRulesModule] })
export class IdentityModule {}
