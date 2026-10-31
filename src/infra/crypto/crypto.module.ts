// Global Nest module for the security primitives (decisions 007, 019): encryption keyring, token hashing, password hashing.
import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';
import { PasswordHasher } from './password-hasher';
import { TokenService } from './token.service';

/**
 * Provides {@link EncryptionService}, {@link TokenService} and {@link PasswordHasher} to every module.
 *
 * Why: sessions, API keys, supplier and gateway credentials and passwords all need the same keys and pepper from the
 * config; the secrets stay inside these classes (decision 019). Webhook signing is a set of pure functions
 * (`webhook-signature.ts`) that takes the endpoint secret as an argument.
 */
@Global()
@Module({
  providers: [EncryptionService, TokenService, PasswordHasher],
  exports: [EncryptionService, TokenService, PasswordHasher],
})
export class CryptoModule {}
