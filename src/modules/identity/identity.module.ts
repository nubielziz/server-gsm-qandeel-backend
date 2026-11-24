// Identity & access module (map domain A): staff, roles, accounts (merchants and customers, decision 064), sessions, auth tokens, API keys,
// IP rules. It owns the authentication and authorization building blocks (src/modules/identity/security) and the IP rules stage
// of the request pipeline (security/ip-rules), the account records and their registries (accounts.module), the staff sign-in routes
// (/admin/auth/*, staff-auth.module), the staff access routes (staff, roles, sessions, IP rules: access-admin.module), the account
// management routes (merchant-admin.module), the account sign-in of both ranks (/client/auth|profile|security|sessions and the services
// the store routes call, merchant-auth.module) and the live event streams of the three signed-in surfaces (realtime/stream.module,
// decision 037) (docs/ARCHITECTURE.md § 2).
import { Module, type OnModuleInit } from '@nestjs/common';
import { GUEST_CLAIM_FILES_NAME, moveGuestClaimFiles } from '../platform';
import { AccessAdminModule } from './access-admin.module';
import { AccountWiringCheckModule } from './account-wiring-check.module';
import { AccountsModule } from './accounts.module';
import { ApiKeysModule } from './api-keys.module';
import { MerchantAdminModule } from './merchant-admin.module';
import { MerchantAuthModule } from './merchant-auth.module';
import { MerchantNotificationsModule } from './merchant-notifications.module';
import { IdentityAudienceModule } from './notifications/identity-audience.module';
import { GuestClaimParticipants } from './ports/guest-claim-participants';
import { StreamRoutesModule } from './realtime/stream.module';
import { IpRulesModule } from './security/ip-rules/ip-rules.module';
import { SecurityModule } from './security/security.module';
import { UploadSessionModule } from './security/upload-session.module';
import { StaffAuthModule } from './staff-auth.module';

/**
 * Nest module for Identity & access (map domain A), the API's entry to it.
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts`
 * (decision 016). Today it provides the security stack (sessions, CSRF, permissions and the guard dispatcher), the account records and
 * their registries (`AccountsModule`, decision 064), the IP rules stage of the request pipeline (`IpRulesModule`, scenario ip-rules), the
 * upload session check that follows the per-IP limit (`UploadSessionModule`, decision 053), the staff sign-in routes (`StaffAuthModule`),
 * the staff access routes (`AccessAdminModule`), the account management routes (`MerchantAdminModule`), the account sign-in
 * (`MerchantAuthModule`), the API key routes (`ApiKeysModule`), the merchant's notification settings (`MerchantNotificationsModule`,
 * feature 12a), the live event streams of the staff member and the account (`StreamRoutesModule`, decision 037) and the boot check of
 * the account registries (`AccountWiringCheckModule`).
 */
@Module({
  imports: [
    SecurityModule,
    AccountsModule,
    IpRulesModule,
    UploadSessionModule,
    StaffAuthModule,
    AccessAdminModule,
    MerchantAdminModule,
    MerchantAuthModule,
    ApiKeysModule,
    MerchantNotificationsModule,
    IdentityAudienceModule,
    StreamRoutesModule,
    AccountWiringCheckModule,
  ],
})
export class IdentityModule implements OnModuleInit {
  constructor(private readonly guestClaims: GuestClaimParticipants) {}

  /**
   * Registers the platform's participant of the guest claim: the files the guest row owns move to the account.
   *
   * Why: the platform imports no other module (decision 032), so it cannot register itself; identity runs the claim and imports the
   * platform. API process only: the worker never runs a claim.
   *
   * @throws {Error} when the name is already registered (a boot error)
   */
  onModuleInit(): void {
    this.guestClaims.register(GUEST_CLAIM_FILES_NAME, moveGuestClaimFiles);
  }
}
