// Public API of the identity module: the module, the security building blocks other modules and features use
// (sessions, cookies, CSRF, the principal and permission helpers, the access guards and the permissions catalog) and
// the IP rules building blocks (the worker's hit flush job; the IP rule routes of feature 2a invalidate the cache).
export { IdentityModule } from './identity.module';
export { SecurityModule } from './security/security.module';
export { AccessGuard } from './security/access.guard';
export { AccessHandlers, PLACEHOLDER_ACCESS_KINDS } from './security/access-handlers';
export type { AccessHandler } from './security/access-handlers';
export { CurrentPrincipal, CurrentStaff, accessStateOf, principalOf } from './security/access-state';
export type { AccessState } from './security/access-state';
export { CSRF_HEADER, CsrfService, csrfTokenFor } from './security/csrf';
export { CsrfGuard } from './security/csrf.guard';
export { ALL_PERMISSIONS, grants, grantsEverything, isValidPermission } from './security/permission-grammar';
export { PermissionGuard } from './security/permission.guard';
export { PermissionsCatalog } from './security/permissions-catalog';
export { assertOwnerTargetAllowed, isOwner } from './security/principal';
export type {
  CustomerPrincipal,
  MerchantPrincipal,
  PermissionHolder,
  Principal,
  SessionPrincipal,
  StaffPrincipal,
} from './security/principal';
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
