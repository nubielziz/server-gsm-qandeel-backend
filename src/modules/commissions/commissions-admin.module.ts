// The routes and use cases of the commissions module (stage 11): plans, assignments, accruals and the approval, and the merchant portal's
// referral page and commissions. Separate from CommissionsModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { AccrualApproval } from './application/accrual-approval.service';
import { AccrualReader } from './application/accrual-reader.service';
import { AssignmentAdminService } from './application/assignment-admin.service';
import { ClientReferrals } from './application/client-referrals.service';
import { PlanAdminService } from './application/plan-admin.service';
import { AccrualsController } from './controllers/accruals.controller';
import { AssignmentsController } from './controllers/assignments.controller';
import { ClientCommissionsController } from './controllers/client-commissions.controller';
import { PlansController } from './controllers/plans.controller';
import { CommissionsEngineModule } from './commissions-engine.module';

/**
 * Provides `/admin/commission-plans*`, `/admin/commission-assignments*`, `/admin/commission-accruals*` and the merchant's `/client/referrals`
 * and `/client/commissions`.
 *
 * Why: these use cases need the global database, audit, configuration and clock providers and the ledger writer of money, which a
 * database-less test app does not have. The engine that accrues commissions is `CommissionsEngineModule`, which the worker loads too.
 */
@Module({
  imports: [CommissionsEngineModule],
  controllers: [PlansController, AssignmentsController, AccrualsController, ClientCommissionsController],
  providers: [PlanAdminService, AssignmentAdminService, AccrualReader, AccrualApproval, ClientReferrals],
})
export class CommissionsAdminModule {}
