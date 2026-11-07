// Public API of the identity module: the module, the staff sign-in tokens (invite and reset links for feature 2a), the
// security building blocks other modules and features use (sessions, cookies, CSRF, the principal and permission helpers,
// the access guards and the permissions catalog), the registries of the machine guards (capability token resolvers, URL
// secrets, gateway webhook adapters, the API key cache) and the IP rules building blocks (the worker's hit flush job).
// Order matters: the request-principal layer (param decorators, principal helpers, the permission grammar) comes first.
// Modules whose controllers use `CurrentStaff` and whose services identity calls (money, catalog) form an import cycle with
// this file; ES modules evaluate these re-exports in source order, so these leaves are initialised before the services that
// lead into that cycle (decision 032; test/unit/module-load.test.ts loads every module index on its own).
export { CurrentMerchant, CurrentPrincipal, CurrentStaff, accessStateOf, principalOf } from './security/access-state';
export type { AccessState } from './security/access-state';
export { ALL_PERMISSIONS, grants, grantsEverything, isValidPermission } from './security/permission-grammar';
export { assertOwnerTargetAllowed, isOwner } from './security/principal';
// Leaf services other modules inject (the catalog's group routes): no dependencies, so they load before anything that leads back.
export { MerchantGroupMembers } from './application/merchant-group-members';
// The gateway webhook adapter registry (no dependencies): billing's verifier injects it, so it loads before the cycle through money.
export { GATEWAY_SLUG, WebhookVerifiers } from './security/machine/webhooks/webhook-verifiers';
export { IdentityModule } from './identity.module';
export { SecurityModule } from './security/security.module';
export { StaffAuthModule } from './staff-auth.module';
export { AccessAdminModule } from './access-admin.module';
export { MerchantAdminModule } from './merchant-admin.module';
export { ClientStatsDirectory, NO_ORDERS } from './application/client-stats';
export type { ClientStats, ClientStatsSource } from './application/client-stats';
export { MERCHANT_INVITED_EVENT } from './application/client-admin.service';
export { cidrToWire } from './domain/ip-rule-input';
export { SessionPurgeModule, SESSION_PURGE_SCHEDULER } from './jobs/session-purge.module';
export { GroupPromotionModule, GROUP_PROMOTION_SCHEDULER } from './jobs/group-promotion.module';
export { GROUP_PROMOTION_JOB } from './jobs/group-promotion.processor';
export { GroupPromotion, PROMOTION_BATCH_SIZE } from './jobs/group-promotion';
export type { PromotionSummary } from './jobs/group-promotion';
export { breaksCreditRule, decidePromotion } from './domain/group-promotion';
export type { CurrentGroup, PromotionTarget } from './domain/group-promotion';
export { SESSION_PURGE_JOB } from './jobs/session-purge.processor';
export { PURGE_BATCH_SIZE, SESSION_RETENTION_DAYS, SessionPurge } from './jobs/session-purge';
export { MerchantAuthModule } from './merchant-auth.module';
export { ApiKeysModule } from './api-keys.module';
export { MerchantWebhookRoutesModule } from './merchant-webhook-routes.module';
export { KycModule } from './kyc.module';
export { MerchantMailModule } from './merchant-mail.module';
export { STAFF_TOKEN_TTL_MS, StaffAuthTokens } from './application/staff-auth-tokens';
export type { IssueStaffTokenInput, IssuedStaffToken } from './application/staff-auth-tokens';
export { STAFF_TOKEN_PURPOSES } from './infra/auth-token.repository';
export type { StaffTokenPurpose } from './infra/auth-token.repository';
export { MERCHANT_TOKEN_TTL_MS, MerchantAuthTokens } from './application/merchant-auth-tokens';
export type { IssueMerchantTokenInput, IssuedMerchantToken } from './application/merchant-auth-tokens';
export { CLIENT_TOKEN_PURPOSES } from './infra/merchant-token.repository';
export type { ClientTokenPurpose } from './infra/merchant-token.repository';
export { MAIL_SENDER } from './application/mail/mail-sender';
export type { MailSender, MerchantMail, MerchantMailKind } from './application/mail/mail-sender';
export { MERCHANT_MAIL_EVENTS, MerchantMailOutbox } from './application/mail/merchant-mail-outbox';
export { checkPasswordPolicy, MIN_PASSWORD_LENGTH } from './domain/password-policy';
export { CLIENT_TOTP_AAD, STAFF_TOTP_AAD, TOTP_ISSUER } from './application/totp.service';
export { AccessGuard } from './security/access.guard';
export { AccessHandlers, PLACEHOLDER_ACCESS_KINDS } from './security/access-handlers';
export type { AccessHandler } from './security/access-handlers';
export { CSRF_HEADER, CsrfService, csrfTokenFor } from './security/csrf';
export { CsrfGuard } from './security/csrf.guard';
export { PermissionGuard } from './security/permission.guard';
export { PermissionsCatalog } from './security/permissions-catalog';
export type {
  ApiKeyPrincipal,
  CapabilityPrincipal,
  CustomerPrincipal,
  MachinePrincipal,
  MerchantPrincipal,
  PermissionHolder,
  Principal,
  SessionPrincipal,
  StaffPrincipal,
  WebhookPrincipal,
} from './security/principal';
export {
  API_KEY_CACHE_TTL_SECONDS,
  API_KEY_TOUCH_INTERVAL_MS,
  ApiKeyDirectory,
  UNKNOWN_API_KEY_TTL_SECONDS,
} from './security/machine/api-keys/api-key.directory';
export { DHRU_SCOPE, checkApiKey, ipAllowedForKey } from './security/machine/api-keys/api-key.rules';
export type { ApiKeyRefusalReason, ApiKeyView } from './security/machine/api-keys/api-key.rules';
export { CAPABILITY_ACCESS_KINDS, CapabilityTokenResolvers } from './security/machine/capability-tokens';
export type {
  CapabilityAccessKind,
  CapabilityGrant,
  CapabilityTokenResolver,
} from './security/machine/capability-tokens';
export { UrlSecretVerifiers } from './security/machine/url-secrets';
export type { StoredUrlSecret, UrlSecretSource } from './security/machine/url-secrets';
export { WEBHOOK_EVENT_TTL_MS, WebhookEventLedger } from './security/machine/webhooks/webhook-event-ledger';
export type {
  VerifiedDelivery,
  WebhookDelivery,
  WebhookVerifier,
  WebhookVerifierResolver,
} from './security/machine/webhooks/webhook-verifiers';
export { REFERENCE_DOCS_PERMISSION, StaffSystemReadGuard } from './security/reference-docs.guard';
export { RolePermissions } from './security/role-permissions';
export { SessionAuthenticator } from './security/session-authenticator';
export type { AuthenticatedSession, SessionAuthOptions } from './security/session-authenticator';
export { CSRF_COOKIE_NAMES, SESSION_COOKIE_NAMES, SessionCookies } from './security/session-cookies';
export { SESSION_DEFAULT_MINUTES, SESSION_SETTING_KEYS, SessionPolicy, isFullSession } from './security/session-policy';
export type { SessionLimits } from './security/session-policy';
export {
  SESSION_CACHE_TTL_SECONDS,
  SessionService,
  TOUCH_INTERVAL_MS,
  UNKNOWN_SESSION_TTL_SECONDS,
} from './security/session.service';
export type { SessionWork } from './security/session.service';
export { livenessOf } from './security/session.types';
export type {
  CreateSessionInput,
  IssuedSession,
  Liveness,
  RotateSessionInput,
  SessionView,
  SubjectSnapshot,
  SubjectState,
} from './security/session.types';
export { liveSessionCondition } from './security/session.repository';
export type { IdleLimits } from './security/session.repository';
export { SessionSubjects } from './security/subject-resolvers';
export type { SessionSubjectResolver } from './security/subject-resolvers';
export { ipAudienceOf } from './security/ip-rules/ip-audience';
export type { IpAudience } from './security/ip-rules/ip-audience';
export { ADMIN_ALLOWLIST_KEY, IpRuleCache } from './security/ip-rules/ip-rule-cache';
export { IpRuleHitsFlushModule, IP_RULE_HITS_FLUSH_SCHEDULER } from './security/ip-rules/ip-rule-hits-flush.module';
export { IP_RULE_HITS_FLUSH_JOB } from './security/ip-rules/ip-rule-hits-flush.processor';
export { IpRuleHits } from './security/ip-rules/ip-rule-hits';
export { IpRuleHitsFlush } from './security/ip-rules/ip-rule-hits-flush';
export type { FlushResult } from './security/ip-rules/ip-rule-hits-flush';
export { compileIpRules, decideIpAccess } from './security/ip-rules/ip-rule-matcher';
export type { ActiveIpRule, CompiledIpRules, IpDecision, IpRuleSnapshot } from './security/ip-rules/ip-rule-matcher';
export { clientAddressOf } from './security/ip-rules/ip-rules.hook';
