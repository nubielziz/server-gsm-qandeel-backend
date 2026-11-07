// Identity & access module (map domain A): staff, roles, merchants, sessions, auth tokens, API keys, KYC, IP rules.
// It owns the authentication and authorization building blocks (src/modules/identity/security) and the IP rules stage
// of the request pipeline (security/ip-rules), the staff sign-in routes (/admin/auth/*, staff-auth.module) and the merchant
// portal's sign-in (/client/auth|profile|security|sessions, merchant-auth.module); the staff, role and IP-rule routes arrive
// with their features (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';
import { MerchantAuthModule } from './merchant-auth.module';
import { IpRulesModule } from './security/ip-rules/ip-rules.module';
import { SecurityModule } from './security/security.module';
import { StaffAuthModule } from './staff-auth.module';

/**
 * Nest module for Identity & access (map domain A).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). Today it provides the security stack (sessions, CSRF, permissions and the guard dispatcher), the IP rules
 * stage of the request pipeline (`IpRulesModule`, scenario ip-rules), the staff sign-in routes (`StaffAuthModule`) and the merchant
 * portal's sign-in (`MerchantAuthModule`).
 */
@Module({ imports: [SecurityModule, IpRulesModule, StaffAuthModule, MerchantAuthModule] })
export class IdentityModule {}
