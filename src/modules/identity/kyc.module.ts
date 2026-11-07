// The verification (KYC) routes of the identity module (stage 8): the staff's view and decision under /admin and the merchant's own
// under /client. Separate so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { StoredFiles } from '../platform';
import { KycService } from './application/kyc.service';
import { KycAdminController, MerchantKycController } from './controllers/kyc.controller';

/**
 * Provides `/admin/kyc-submissions*` and `/client/kyc`.
 *
 * Why: the routes need the global database, audit and clock providers and the platform's file reader (`StoredFiles`, which needs
 * the object store), which a database-less test app does not have.
 */
@Module({
  controllers: [KycAdminController, MerchantKycController],
  providers: [StoredFiles, KycService],
})
export class KycModule {}
