// The security stack of the identity module (decision 018): sessions, CSRF, permissions, the guard dispatcher, the machine
// guards (API keys, Dhru credentials, capability tokens, URL secrets, gateway signatures) and the staff gate of the internal
// reference. Global, because the dispatcher guards every route and other modules read the principal, register session subject
// resolvers, token resolvers and webhook adapters, and revoke sessions.
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MetricsAccessGuard } from '../../../infra/metrics';
import { REFERENCE_DOCS_GUARD, SettingsModule } from '../../platform';
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
 * cache, Redis, rate-limit and crypto modules and the platform settings reader.
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
  ],
})
export class SecurityModule {}
