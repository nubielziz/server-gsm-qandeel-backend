// PaymentWebhookVerifier: gives the signature registry of P2.5c the adapters of the configured payment gateways (decisions 018, 019).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { WebhookVerifiers, type WebhookVerifier } from '../../identity';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGatewayByCode } from '../infra/gateway.repository';
import { GatewayCredentialsVault } from './gateway-credentials';

const NO_WEBHOOK = 'No webhook is set up for this gateway.';

/**
 * Verifies the signature of `POST /webhooks/payments/:gateway` with the code of the gateway's driver.
 *
 * Why: gateways are rows staff add at run time, and `:gateway` is a row's `code` (it never changes), so the registry asks this
 * resolver at the moment of the request: it reads the gateway, takes the signing key the driver says it uses (the webhook secret
 * or the API secret, money-14), decrypts it (decision 019) and hands the delivery to the driver. A manual gateway, a driver with no
 * code behind it and a gateway with no key all answer `400 WEBHOOK_SIGNATURE_INVALID` like an unknown gateway, so a caller learns
 * nothing about which gateways exist. The 5-minute window and the event-id replay filter are the guard's (P2.5c).
 *
 * Side effects: registers the resolver at boot; reads `payment_gateways` and decrypts one key per delivery.
 */
@Injectable()
export class PaymentWebhookVerifier implements OnModuleInit {
  constructor(
    private readonly verifiers: WebhookVerifiers,
    private readonly db: DbService,
    private readonly vault: GatewayCredentialsVault,
  ) {}

  /** Registers the resolver with the P2.5c registry. */
  onModuleInit(): void {
    this.verifiers.setResolver((slug) => this.resolve(slug));
  }

  /**
   * Finds the verifier of a gateway code.
   *
   * @param slug the code from the URL
   * @returns the verifier, or `undefined` when no automatic gateway with a known driver has that code
   */
  async resolve(slug: string): Promise<WebhookVerifier | undefined> {
    const gateway = await findGatewayByCode(this.db.db, slug);
    const driver = gateway && !gateway.isManual ? driverFor(gateway.driver) : undefined;
    if (!gateway || !driver) return undefined;
    return {
      gateway: slug,
      verify: (delivery) => {
        const credentials = this.vault.read(gateway);
        const key = driver.signingKey === 'api_secret' ? credentials.secret : credentials.webhookSecret;
        if (!key) throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: NO_WEBHOOK });
        return driver.verify(delivery, key);
      },
    };
  }
}
