// The route and use case of the storefront IMEI check (stage 14). Separate from RiskModule so a test app built without a database
// can leave it out.
import { Module } from '@nestjs/common';
import { ImeiCheckService } from './application/imei-check.service';
import { ImeiCheckController } from './controllers/imei-check.controller';

/**
 * Provides `POST /store/v1/imei/check`.
 *
 * Why: the use case needs the global database, crypto, clock and catalog providers, which a database-less test app does not have.
 */
@Module({ controllers: [ImeiCheckController], providers: [ImeiCheckService] })
export class ImeiCheckModule {}
