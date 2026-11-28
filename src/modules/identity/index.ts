// Public API of the identity module: the module, the staff sign-in tokens (invite and reset links for feature 2a), the
// security building blocks other modules and features use (sessions, cookies, CSRF, the principal and permission helpers,
// the access guards and the permissions catalog), the registries of the machine guards (capability token resolvers, URL
// secrets, gateway webhook adapters, the API key cache), the IP rules building blocks (the worker's hit flush job) and the module of
// the live event stream routes (decision 037).
// Order matters: the request-principal layer (param decorators, principal helpers, the permission grammar) comes first.
// Modules whose controllers use `CurrentStaff` and whose services identity calls (money, catalog) form an import cycle with
// this file; ES modules evaluate these re-exports in source order, so these leaves are initialised before the services that
// lead into that cycle (decision 032; test/tooling/module-load.test.ts loads every module index on its own).
export {
  CurrentLink,
  CurrentMerchant,
  CurrentPrincipal,
  CurrentStaff,
  accessStateOf,
  principalOf,
} from './security/access-state';
export type { AccessState } from './security/access-state';
// The principal of a signed-in account, the actor it stands for and the decorator that hands it to a handler (decision 064). A leaf like
// `access-state`, which it reads, so it follows it.
export { CurrentAccount, actorOf } from './ports/account-principal';
export type { AccountActor, AccountPrincipal } from './ports/account-principal';
export {
  ALL_PERMISSIONS,
  grants,
  grantsEverything,
  isValidPermission,
  uncoveredPermissions,
} from './security/permission-grammar';
export {
  CUSTOMER_CONTACT_PERMISSION,
  assertOwnerTargetAllowed,
  assertWithinCeiling,
  customerContactOf,
  isOwner,
  missingPermission,
  requireOwner,
  requirePermission,
} from './security/principal';
// The rank and status helpers (pure) and the seams other modules code against (decision 064): abstract classes and registries with no
// dependencies, so they load before anything that leads into the import cycle through money and catalog.
export { canAct, sessionStateOf } from './accounts/account-status';
export type { SessionState } from './accounts/account-status';
export { rankKindOf } from './ports/rank-kind';
export type { RankKind } from './ports/rank-kind';
export { AccountSessions } from './ports/account-sessions';
export type { AccountSessionStart } from './ports/account-sessions';
export { ApiKeyRevocation } from './ports/api-key-revocation';
export { ACCOUNT_TOKEN_PURPOSES, AccountAuthTokens } from './ports/account-auth-tokens';
export type { AccountTokenPurpose, IssueAccountTokenInput, TakenAccountToken } from './ports/account-auth-tokens';
export { AccountMailOutbox } from './ports/account-mail-outbox';
export type { AccountMailKind } from './ports/account-mail-outbox';
export {
  AccountEmailVerification,
  AccountLinkSignIn,
  AccountOwnPassword,
  AccountSignIn,
  AccountTwoFactorSetup,
} from './ports/account-auth';
export type {
  AccountForcedChangeAnswer,
  AccountLinkBrowser,
  AccountLinkExchange,
  AccountLinkExchangeInput,
  AccountRankSummary,
  AccountSignInAnswer,
  AccountSignInInput,
  AccountSignInStep,
  AccountSignUpDetails,
  AccountSignUpFinishInput,
  AccountSignUpInput,
  AccountTwoFactorSetupAnswer,
} from './ports/account-auth';
export { OptionalAccountSession } from './ports/optional-account-session';
export { AccountOwnProfile } from './ports/account-own-profile';
export type { AccountMeView, RetailProfileColumns } from './ports/account-own-profile';
export { AccountAccessEffects } from './ports/account-access-effects';
export type { RankChangeEffects, StatusChangeEffects } from './ports/account-access-effects';
export { AccountCreateGuards } from './ports/account-create-guards';
export type { AccountCreateCheck, AccountCreateFacts } from './ports/account-create-guards';
export { GuestClaimBusy, GuestClaimParticipants, ORDERS_PARTICIPANT } from './ports/guest-claim-participants';
export type { GuestClaimIds, GuestClaimMove } from './ports/guest-claim-participants';
export { AccountListSql } from './ports/account-list-sql';
export type { OrderFigure, OrderFigureSql, WalletBalanceSql } from './ports/account-list-sql';
// Leaf services other modules inject (the catalog's group routes): no dependencies, so they load before anything that leads back.
export { MerchantGroupMembers } from './application/merchant-group-members';
// The gateway webhook adapter registry (no dependencies): billing's verifier injects it, so it loads before the cycle through money.
export { GATEWAY_SLUG, WebhookVerifiers } from './security/machine/webhooks/webhook-verifiers';
// The account directory, the legacy id map and the rank writer (decision 064). They read the ranks through the catalog's `RankGroupReads`,
// so they come after the registries above: the catalog's index leads into money, whose verifier injects `WebhookVerifiers`.
export { AccountDirectory } from './accounts/account-directory';
export type { AccountRecord, GuestInput, GuestResult } from './accounts/account-directory';
export { LegacyAccounts, accountHistorySql, legacyAccountIdSql, legacySpaceOf } from './accounts/legacy-accounts';
export type { LegacyLookupType, LegacyPair } from './accounts/legacy-accounts';
export { AccountRanks } from './accounts/account-ranks';
export { IdentityModule } from './identity.module';
export { IdentityAudienceModule } from './notifications/identity-audience.module';
export { MerchantAudience } from './notifications/merchant-audience';
export { StaffAudience } from './notifications/staff-audience';
export { SecurityModule } from './security/security.module';
export { StreamRoutesModule } from './realtime/stream.module';
export { StaffAuthModule } from './staff-auth.module';
export { AccessAdminModule } from './access-admin.module';
export { MerchantAdminModule } from './merchant-admin.module';
export { ClientStatsDirectory, NO_ORDERS } from './application/client-stats';
export type { ClientStats, ClientStatsSource } from './application/client-stats';
export { MERCHANT_INVITED_EVENT } from './application/client-admin.service';
export { cidrToWire } from './domain/ip-rule-input';
export { SessionPurgeModule, SESSION_PURGE_SCHEDULER, SIGN_UP_PURGE_SCHEDULER } from './jobs/session-purge.module';
export { SESSION_PURGE_JOB } from './jobs/session-purge.processor';
export { SIGN_UP_PURGE_JOB, SignUpPurgeProcessor } from './jobs/sign-up-purge.processor';
export { PURGE_BATCH_SIZE, SESSION_RETENTION_DAYS, SessionPurge } from './jobs/session-purge';
export { MerchantAuthModule } from './merchant-auth.module';
export { ApiKeysModule } from './api-keys.module';
export { MerchantNotificationsModule } from './merchant-notifications.module';
export { MerchantMailModule } from './merchant-mail.module';
export { IdentityMailEventsModule } from './identity-mail-events.module';
export { StaffMailModule } from './staff-mail.module';
export { STAFF_MAIL_EVENTS, StaffMailOutbox } from './application/mail/staff-mail-outbox';
export type { StaffMailKind } from './application/mail/staff-mail-outbox';
export { IDENTITY_MAIL_EVENTS } from './application/mail/identity-mail-events';
export {
  IDENTITY_DEFAULT_TEMPLATES,
  IDENTITY_TEMPLATES_MIGRATION,
  identityTemplatesSql,
} from './application/mail/identity-templates';
export { STAFF_TOKEN_TTL_MS, StaffAuthTokens } from './application/staff-auth-tokens';
export type { IssueStaffTokenInput, IssuedStaffToken } from './application/staff-auth-tokens';
export { STAFF_TOKEN_PURPOSES } from './infra/auth-token.repository';
export type { StaffTokenPurpose } from './infra/auth-token.repository';
export { MERCHANT_TOKEN_TTL_MS, MerchantAuthTokens } from './application/merchant-auth-tokens';
export type { IssueMerchantTokenInput, IssuedMerchantToken } from './application/merchant-auth-tokens';
export { CLIENT_TOKEN_PURPOSES } from './infra/merchant-token.repository';
export type { ClientTokenPurpose } from './infra/merchant-token.repository';
export { TEMPORARY_PASSWORD_TTL_MS, temporaryPasswordExpired, temporaryPasswordFor } from './domain/temporary-password';
// The sign-in lock and the budget of the mails a visitor can ask for (decision 052): the customers module mails the links of the retail rank.
export { SignInLockModule } from './sign-in-lock.module';
export { SignInLock } from './application/sign-in-lock';
export type { SignInAccount } from './application/sign-in-lock';
export type { SignInScope } from './domain/sign-in-lock';
export { takePublicMailPoint } from './application/public-mail-budget';
export {
  ACCOUNT_AREA_PATH,
  MAX_LIVE_PUBLIC_LINKS,
  NO_ACCOUNT_ID,
  accountAreaUrl,
  accountMailLink,
} from './domain/public-links';
export { ACCOUNT_MAIL_EVENTS } from './domain/account-mail';
// The Owner role definition and the staff field rules `bun run setup` shares with the seed and the staff routes (P4b).
export { OWNER_ROLE_NAME, OWNER_ROLE_PERMISSIONS } from './domain/owner-role';
// The Owner-only rule of a rank change (decision 064): the rank route of the money module asks it.
export { RANK_OWNER_DETAIL, assertMayChangeRank } from './domain/account-rules';
export { EmailField, NameField } from './contracts/shared';
export { MERCHANT_MAIL_EVENTS, MerchantMailOutbox } from './application/mail/merchant-mail-outbox';
export type { MerchantMailKind } from './application/mail/merchant-mail-outbox';
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
  CeilingSubject,
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
export { checkApiKey, ipAllowedForKey } from './security/machine/api-keys/api-key.rules';
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
export { requestMetaOf } from './application/request-meta';
export type { RequestMeta } from './application/request-meta';
