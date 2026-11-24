// The API key routes of the identity module (stage 7): the merchant's read-only list under /client/api-keys and the staff's view, creation,
// limits and revocation under /admin (decision 067). Separate so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { ApiKeyAdminService } from './application/api-key-admin.service';
import { ApiKeyIssuer } from './application/api-key-issuer';
import { MerchantApiKeyService } from './application/merchant-api-key.service';
import { ApiKeysAdminController, MerchantApiKeysController } from './controllers/api-keys.controller';
import { MerchantMailModule } from './merchant-mail.module';

/**
 * Provides `GET /client/api-keys`, `GET` and `POST /admin/clients/:id/api-keys`, and `PATCH` and `DELETE /admin/api-keys/:id`.
 *
 * Why: the routes need the global database, crypto, audit and clock providers and the API key directory of the security stack
 * (they drop a key's cached view after a change) and the merchant mails of `MerchantMailModule` (the notice of a key staff made or changed); the module is exported to the rest of the app only through `index.ts`.
 */
@Module({
  imports: [MerchantMailModule],
  controllers: [MerchantApiKeysController, ApiKeysAdminController],
  providers: [ApiKeyIssuer, MerchantApiKeyService, ApiKeyAdminService],
})
export class ApiKeysModule {}
