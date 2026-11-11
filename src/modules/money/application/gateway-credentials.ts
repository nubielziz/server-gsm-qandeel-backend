// GatewayCredentials: reads and writes the encrypted credentials of a payment gateway (decision 019): the API credential and
// address in `config_enc`, the webhook signing keys (one or two, feature 24C) in `webhook_secret_enc`.
import { Injectable, Logger } from '@nestjs/common';
import { DecryptionError, EncryptionService } from '../../../infra/crypto';
import type { PaymentGateway } from '../db/schema';
import type { GatewayCredentials } from '../infra/gateway-drivers/driver';

/** The AAD of `payment_gateways.config_enc` (decision 019: `<table>.<column>`). */
export const GATEWAY_CONFIG_AAD = 'payment_gateways.config_enc';
/** The AAD of `payment_gateways.webhook_secret_enc`. */
export const GATEWAY_WEBHOOK_SECRET_AAD = 'payment_gateways.webhook_secret_enc';
/** How many webhook signing keys a gateway keeps: one per endpoint, or the old and the new one while rotating. */
export const MAX_WEBHOOK_SECRETS = 2;

/**
 * The webhook keys of a decrypted `webhook_secret_enc`.
 *
 * Why: the column held one plain key before feature 24C and holds a JSON array of one or two keys since; both forms are read, so
 * nothing is migrated. A value that is neither (not JSON, or JSON of another shape) is one key.
 *
 * @param plain the decrypted text
 * @returns the keys, in order (the first is the "webhook secret", the second the "second webhook secret")
 */
export function webhookSecretsOf(plain: string): string[] {
  if (plain.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(plain);
      if (
        Array.isArray(parsed) &&
        parsed.length >= 1 &&
        parsed.length <= MAX_WEBHOOK_SECRETS &&
        parsed.every((item) => typeof item === 'string' && item !== '')
      ) {
        return parsed as string[];
      }
    } catch {
      // not JSON: a single key that starts with `[`
    }
  }
  return plain === '' ? [] : [plain];
}

/**
 * Encrypts and decrypts what a gateway row keeps secret.
 *
 * Why: RESOLUTIONS money-14: the console's write-only `secret` is the driver's API credential, stored as `{"secret": "..."}` (with
 * an optional `apiBase` when the gateway's API is not at the driver's default address); the optional `webhookSecret` (and, since 24C, a
 * second one) is the key the gateway signs its webhooks with. Nothing here is ever logged or sent to a client.
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
   * @returns the API credential, API address and webhook keys; a part that is missing or cannot be decrypted is `undefined` (or no key)
   *   (the failure is logged without the value)
   */
  read(row: Pick<PaymentGateway, 'id' | 'configEnc' | 'webhookSecretEnc'>): GatewayCredentials {
    const config = this.config(row);
    const secret = typeof config['secret'] === 'string' && config['secret'] !== '' ? config['secret'] : undefined;
    const apiBase = typeof config['apiBase'] === 'string' && config['apiBase'] !== '' ? config['apiBase'] : undefined;
    const webhookSecrets = this.webhookSecrets(row);
    return { secret, apiBase, webhookSecret: webhookSecrets[0], webhookSecrets };
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
   * Seals the webhook signing keys of a gateway (always as a JSON array, one key included).
   *
   * @param secrets one or two non-empty keys, the first one first
   * @returns the `webhook_secret_enc` text
   * @throws {RangeError} for no key, more than two, or an empty one (a caller's bug: the service checks the request first)
   */
  sealWebhookSecrets(secrets: readonly string[]): string {
    if (secrets.length < 1 || secrets.length > MAX_WEBHOOK_SECRETS || secrets.some((secret) => secret === '')) {
      throw new RangeError('A gateway keeps one or two non-empty webhook keys.');
    }
    return this.encryption.encrypt(JSON.stringify(secrets), GATEWAY_WEBHOOK_SECRET_AAD);
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

  private webhookSecrets(row: Pick<PaymentGateway, 'id' | 'webhookSecretEnc'>): string[] {
    if (!row.webhookSecretEnc) return [];
    try {
      return webhookSecretsOf(this.encryption.decrypt(row.webhookSecretEnc, GATEWAY_WEBHOOK_SECRET_AAD));
    } catch (error) {
      this.logger.error(
        `The webhook key of gateway ${row.id} cannot be read (${error instanceof DecryptionError ? error.reason : 'invalid'}).`,
      );
      return [];
    }
  }
}
