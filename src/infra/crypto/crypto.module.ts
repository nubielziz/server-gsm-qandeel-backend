// Global Nest module for the security primitives (decisions 007, 019): encryption keyring, token hashing, password hashing.
import { Global, Module } from '@nestjs/common';
import { CapabilityTokenVault } from './capability-token-vault';
import { EncryptionService } from './encryption.service';
import { PasswordHasher } from './password-hasher';
import { TokenService } from './token.service';

/**
 * Provides {@link EncryptionService}, {@link TokenService}, {@link PasswordHasher} and {@link CapabilityTokenVault} to every module.
 *
 * Why: sessions, API keys, supplier and gateway credentials and passwords all need the same keys and pepper from the
 * config; the secrets stay inside these classes (decision 019). Webhook signatures are a set of pure functions
 * (`webhook-signature.ts`) that take the gateway secret as an argument.
 */
@Global()
@Module({
  providers: [EncryptionService, TokenService, PasswordHasher, CapabilityTokenVault],
  exports: [EncryptionService, TokenService, PasswordHasher, CapabilityTokenVault],
})
export class CryptoModule {}
