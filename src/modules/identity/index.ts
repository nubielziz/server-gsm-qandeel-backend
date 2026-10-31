// Public API of the identity module: the module, and the security building blocks other modules and features use
// (sessions, cookies, CSRF, the principal and permission helpers, the access guards and the permissions catalog).
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
