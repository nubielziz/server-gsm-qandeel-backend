// Public API of the crypto infrastructure (decisions 007, 019): the module and services, plus the pure helpers.
export { CryptoModule } from './crypto.module';
export { CAPABILITY_TOKEN_COLUMNS, CapabilityTokenVault } from './capability-token-vault';
export type { CapabilityTokenKind, SealedCapabilityToken } from './capability-token-vault';
export { SEAL_PAGE, sealCapabilityTokens } from './capability-token-seal';
export type { CapabilityTokenTable, SealOutcome, UnsealedCapabilityToken } from './capability-token-seal';
export { DecryptionError, EncryptionService } from './encryption.service';
export type { DecryptionFailure } from './encryption.service';
export { MAX_PASSWORD_BYTES, PasswordHasher } from './password-hasher';
export { TokenService } from './token.service';
export { MIN_TOKEN_BYTES, constantTimeEqual, hashToken, randomToken } from './tokens';
export {
  WEBHOOK_TOLERANCE_SECONDS,
  assertWebhookSignature,
  signWebhook,
  verifyWebhookSignature,
} from './webhook-signature';
export type { WebhookRefusal, WebhookVerification, WebhookVerifyOptions } from './webhook-signature';
