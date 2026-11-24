// The security stack of the identity module (decision 018): sessions, CSRF, permissions, the guard dispatcher, the machine
// guards (API keys, Dhru credentials, capability tokens, URL secrets, gateway signatures) and the staff gate of the internal
// reference. Global, because the dispatcher guards every route and other modules read the principal, register session subject
// resolvers, token resolvers and webhook adapters, and revoke sessions. It also binds the account seams of the session core (decision
// 064): the account sessions, the revocation of an account's API keys, the optional shop session and the rank kind lookup.
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MetricsAccessGuard } from '../../../infra/metrics';
import { REFERENCE_DOCS_GUARD, SettingsModule } from '../../platform';
import { OptionalAccountSessionService } from '../application/optional-account-session';
import { RankKindsInstaller } from '../application/rank-kinds.installer';
import { AccountSessions } from '../ports/account-sessions';
import { ApiKeyRevocation } from '../ports/api-key-revocation';
import { OptionalAccountSession } from '../ports/optional-account-session';
import { AccessGuard } from './access.guard';
import { AccessHandlers } from './access-handlers';
import { CsrfGuard } from './csrf.guard';
import { CsrfService } from './csrf';
import { ApiKeyAuthenticator } from './machine/api-keys/api-key.authenticator';
import { ApiKeyDirectory } from './machine/api-keys/api-key.directory';
import { CapabilityTokenResolvers } from './machine/capability-tokens';
import { MachineAccessInstaller } from './machine/machine-access.installer';
import { UrlSecretVerifiers } from './machine/url-secrets';
import { WebhookEventLedger } from './machine/webhooks/webhook-event-ledger';
import { WebhookVerifiers } from './machine/webhooks/webhook-verifiers';
import { PermissionGuard } from './permission.guard';
import { PermissionsCatalog } from './permissions-catalog';
import { RankKinds } from './rank-kinds';
import { StaffSystemReadGuard } from './reference-docs.guard';
import { RolePermissions } from './role-permissions';
import { SessionAuthenticator } from './session-authenticator';
import { SessionCookies } from './session-cookies';
import { SessionPolicy } from './session-policy';
import { SessionService } from './session.service';
import { SessionSubjects } from './subject-resolvers';

/**
 * Provides the session services and installs the guard dispatcher for every route.
 *
 * Why: authentication, CSRF and permissions are decided from the route contract in one global guard (`AccessGuard`), so no
 * route can forget them. The same module provides the guard behind `REFERENCE_DOCS=staff`, and the registries the owning
 * modules fill later (capability token resolvers, URL secrets, gateway webhook adapters). It needs the global database,
 * cache, Redis, rate-limit and crypto modules, the platform settings reader and the catalog's global `RankGroupReads` (the rank kind of
 * a session, installed at boot by `RankKindsInstaller`: without it every account session is refused).
 *
 * Port bindings (decision 064): `AccountSessions` is `SessionService`, `ApiKeyRevocation` is `ApiKeyDirectory`, `OptionalAccountSession`
 * is `OptionalAccountSessionService` (the checkout routes of the customers module read it); each port resolves to the instance the
 * module's own services use.
 */
@Global()
@Module({
  imports: [SettingsModule],
  providers: [
    SessionPolicy,
    SessionSubjects,
    SessionService,
    RolePermissions,
    CsrfService,
    SessionCookies,
    SessionAuthenticator,
    MetricsAccessGuard,
    AccessHandlers,
    ApiKeyDirectory,
    ApiKeyAuthenticator,
    CapabilityTokenResolvers,
    UrlSecretVerifiers,
    WebhookVerifiers,
    WebhookEventLedger,
    MachineAccessInstaller,
    CsrfGuard,
    PermissionGuard,
    AccessGuard,
    PermissionsCatalog,
    StaffSystemReadGuard,
    RankKinds,
    RankKindsInstaller,
    OptionalAccountSessionService,
    { provide: AccountSessions, useExisting: SessionService },
    { provide: ApiKeyRevocation, useExisting: ApiKeyDirectory },
    { provide: OptionalAccountSession, useExisting: OptionalAccountSessionService },
    { provide: APP_GUARD, useExisting: AccessGuard },
    { provide: REFERENCE_DOCS_GUARD, useExisting: StaffSystemReadGuard },
  ],
  exports: [
    SessionPolicy,
    SessionSubjects,
    SessionService,
    RolePermissions,
    CsrfService,
    SessionCookies,
    SessionAuthenticator,
    AccessHandlers,
    ApiKeyDirectory,
    CapabilityTokenResolvers,
    UrlSecretVerifiers,
    WebhookVerifiers,
    PermissionsCatalog,
    REFERENCE_DOCS_GUARD,
    RankKinds,
    AccountSessions,
    ApiKeyRevocation,
    OptionalAccountSession,
  ],
})
export class SecurityModule {}
