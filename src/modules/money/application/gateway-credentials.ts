// GatewayCredentials: reads and writes the encrypted credentials of a payment gateway (decision 019): the API credential and
// address in `config_enc`, the webhook signing key in `webhook_secret_enc`.
import { Injectable, Logger } from '@nestjs/common';
import { DecryptionError, EncryptionService } from '../../../infra/crypto';
import type { PaymentGateway } from '../db/schema';
import type { GatewayCredentials } from '../infra/gateway-drivers/driver';

/** The AAD of `payment_gateways.config_enc` (decision 019: `<table>.<column>`). */
export const GATEWAY_CONFIG_AAD = 'payment_gateways.config_enc';
/** The AAD of `payment_gateways.webhook_secret_enc`. */
export const GATEWAY_WEBHOOK_SECRET_AAD = 'payment_gateways.webhook_secret_enc';

/**
 * Encrypts and decrypts what a gateway row keeps secret.
 *
 * Why: RESOLUTIONS money-14: the console's write-only `secret` is the driver's API credential, stored as `{"secret": "..."}` (with
 * an optional `apiBase` when the gateway's API is not at the driver's default address); the optional `webhookSecret` is the key the
 * gateway signs its webhooks with. Nothing here is ever logged or sent to a client.
 *
 * Side effects: none (pure encryption with the keyring).
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class GatewayCredentialsVault {
  private readonly logger = new Logger(GatewayCredentialsVault.name);

  constructor(private readonly encryption: EncryptionService) {}

  /**
   * Reads the credentials of a gateway.
   *
   * @param row the gateway row
   * @returns the API credential, API address and webhook key; a part that is missing or cannot be decrypted is `undefined`
   *   (the failure is logged without the value)
   */
  read(row: Pick<PaymentGateway, 'id' | 'configEnc' | 'webhookSecretEnc'>): GatewayCredentials {
    const config = this.config(row);
    const secret = typeof config['secret'] === 'string' && config['secret'] !== '' ? config['secret'] : undefined;
    const apiBase = typeof config['apiBase'] === 'string' && config['apiBase'] !== '' ? config['apiBase'] : undefined;
    return { secret, apiBase, webhookSecret: this.webhookSecret(row) };
  }

  /**
   * Seals the API credential (and address) of a gateway.
   *
   * @param current the stored `config_enc`, to keep what the request did not change
   * @param change the new credential and/or API address; omit a key to keep it
   * @param id the gateway id (for the log)
   * @returns the new `config_enc` text
   */
  sealConfig(
    current: string | null,
    change: { readonly secret?: string; readonly apiBase?: string },
    id: number,
  ): string {
    const merged = { ...this.config({ id, configEnc: current }), ...change };
    return this.encryption.encrypt(JSON.stringify(merged), GATEWAY_CONFIG_AAD);
  }

  /**
   * Seals the webhook signing key of a gateway.
   *
   * @param secret the key
   * @returns the `webhook_secret_enc` text
   */
  sealWebhookSecret(secret: string): string {
    return this.encryption.encrypt(secret, GATEWAY_WEBHOOK_SECRET_AAD);
  }

  private config(row: Pick<PaymentGateway, 'id' | 'configEnc'>): Record<string, unknown> {
    if (!row.configEnc) return {};
    try {
      const parsed: unknown = JSON.parse(this.encryption.decrypt(row.configEnc, GATEWAY_CONFIG_AAD));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (error) {
      this.logger.error(
        `The credentials of gateway ${row.id} cannot be read (${error instanceof DecryptionError ? error.reason : 'invalid'}).`,
      );
      return {};
    }
  }

  private webhookSecret(row: Pick<PaymentGateway, 'id' | 'webhookSecretEnc'>): string | undefined {
    if (!row.webhookSecretEnc) return undefined;
    try {
      return this.encryption.decrypt(row.webhookSecretEnc, GATEWAY_WEBHOOK_SECRET_AAD);
    } catch (error) {
      this.logger.error(
        `The webhook key of gateway ${row.id} cannot be read (${error instanceof DecryptionError ? error.reason : 'invalid'}).`,
      );
      return undefined;
    }
  }
}
