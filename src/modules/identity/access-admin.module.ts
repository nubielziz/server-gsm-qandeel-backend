// The staff access routes of the identity module (stage 2, scenarios admin-team and ip-rules): staff, roles, the permission
// catalog, live sessions, IP rules and the admin access restriction. Separate from SecurityModule and StaffAuthModule so a test
// app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { IpRuleAdminService } from './application/ip-rule-admin.service';
import { RoleAdminService } from './application/role-admin.service';
import { SessionAdminService } from './application/session-admin.service';
import { StaffAdminService } from './application/staff-admin.service';
import { IpRulesController } from './controllers/ip-rules.controller';
import { RolesController } from './controllers/roles.controller';
import { SessionsController } from './controllers/sessions.controller';
import { StaffController } from './controllers/staff.controller';
import { IpRulesModule } from './security/ip-rules/ip-rules.module';
import { StaffAuthModule } from './staff-auth.module';

/**
 * Provides `/admin/staff`, `/admin/roles`, `/admin/permissions`, `/admin/sessions`, `/admin/ip-rules` and
 * `/admin/access/restriction`.
 *
 * Why: the routes need the global database, crypto, settings, audit and security providers (sessions, role permissions, the
 * permission catalog) plus the staff link tokens of `StaffAuthModule` and the IP rule cache of `IpRulesModule`.
 */
@Module({
  imports: [StaffAuthModule, IpRulesModule],
  controllers: [StaffController, RolesController, SessionsController, IpRulesController],
  providers: [StaffAdminService, RoleAdminService, SessionAdminService, IpRuleAdminService],
})
export class AccessAdminModule {}
