// The API key routes of the identity module (stage 7): the merchant's own keys under /client/api-keys and the staff's view and
// revocation under /admin. Separate so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { ApiKeyAdminService } from './application/api-key-admin.service';
import { MerchantApiKeyService } from './application/merchant-api-key.service';
import { ApiKeysAdminController, MerchantApiKeysController } from './controllers/api-keys.controller';

/**
 * Provides `/client/api-keys`, `GET /admin/clients/:id/api-keys` and `DELETE /admin/api-keys/:id`.
 *
 * Why: the routes need the global database, crypto, audit and clock providers and the API key directory of the security stack
 * (they drop a key's cached view after a change); the module is exported to the rest of the app only through `index.ts`.
 */
@Module({
  controllers: [MerchantApiKeysController, ApiKeysAdminController],
  providers: [MerchantApiKeyService, ApiKeyAdminService],
})
export class ApiKeysModule {}
