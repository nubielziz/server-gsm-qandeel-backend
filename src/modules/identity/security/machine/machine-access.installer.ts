// Installs the real guards of the machine access kinds (P2.5c) in place of the fail-closed placeholders of P2.5a.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { TokenService } from '../../../../infra/crypto';
import { AccessHandlers } from '../access-handlers';
import { ApiKeyAuthenticator } from './api-keys/api-key.authenticator';
import { ApiKeyAccessHandler, DhruCredentialsAccessHandler } from './api-keys/api-key.handlers';
import { CAPABILITY_ACCESS_KINDS, CapabilityAccessHandler, CapabilityTokenResolvers } from './capability-tokens';
import { UrlSecretAccessHandler, UrlSecretVerifiers } from './url-secrets';
import { GatewaySignatureAccessHandler } from './webhooks/gateway-signature.handler';
import { WebhookEventLedger } from './webhooks/webhook-event-ledger';
import { WebhookVerifiers } from './webhooks/webhook-verifiers';

/**
 * Gives the machine access kinds their guards.
 *
 * Why: P2.5a left `api-key`, `dhru-credentials`, `gateway-signature`, `url-secret` and the four capability-token kinds refusing
 * every request. This replaces each with its guard through `AccessHandlers.replace`. It does so in the constructor, which Nest
 * runs when the module is built, before any `onModuleInit`: a test module that installs its own stand-in handler in
 * `onModuleInit` (test/support/pipeline-routes.ts) therefore wins, and the real handlers never overwrite it afterwards.
 */
@Injectable()
export class MachineAccessInstaller {
  constructor(
    handlers: AccessHandlers,
    apiKeys: ApiKeyAuthenticator,
    capabilityResolvers: CapabilityTokenResolvers,
    urlSecrets: UrlSecretVerifiers,
    tokens: TokenService,
    webhookVerifiers: WebhookVerifiers,
    webhookEvents: WebhookEventLedger,
    @Inject(CLOCK) clock: Clock,
  ) {
    handlers.replace('api-key', new ApiKeyAccessHandler(apiKeys));
    handlers.replace('dhru-credentials', new DhruCredentialsAccessHandler(apiKeys));
    for (const kind of CAPABILITY_ACCESS_KINDS) {
      handlers.replace(kind, new CapabilityAccessHandler(kind, capabilityResolvers));
    }
    handlers.replace('url-secret', new UrlSecretAccessHandler(urlSecrets, tokens));
    handlers.replace('gateway-signature', new GatewaySignatureAccessHandler(webhookVerifiers, webhookEvents, clock));
  }
}
