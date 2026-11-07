// The merchant management routes of the identity module (stage 2, route group /admin/clients): controller, use cases, invite
// tokens and the seam for the orders module's 30-day figures. Separate so a test app built without a database can leave it out.
import { Global, Module } from '@nestjs/common';
import { ClientAdminService } from './application/client-admin.service';
import { ClientStatsDirectory } from './application/client-stats';
import { MerchantGroupMembers } from './application/merchant-group-members';
import { MerchantInvites } from './application/merchant-invites';
import { ClientsController } from './controllers/clients.controller';
import { MerchantMailModule } from './merchant-mail.module';

/**
 * Provides `/admin/clients` and the merchant group member counts the catalog's group routes read.
 *
 * Why: the routes need the global database, audit, security, money (wallet accounts) and catalog (groups) providers, and the merchant mail outbox (the invitation link). It
 * is global because the orders module injects `ClientStatsDirectory` to register its source (feature 5).
 */
@Global()
@Module({
  imports: [MerchantMailModule],
  controllers: [ClientsController],
  providers: [ClientAdminService, ClientStatsDirectory, MerchantGroupMembers, MerchantInvites],
  exports: [ClientStatsDirectory, MerchantGroupMembers],
})
export class MerchantAdminModule {}
