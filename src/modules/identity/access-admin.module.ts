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
import { SignInLockModule } from './sign-in-lock.module';
import { StaffAuthModule } from './staff-auth.module';
import { StaffMailModule } from './staff-mail.module';

/**
 * Provides `/admin/staff`, `/admin/roles`, `/admin/permissions`, `/admin/sessions`, `/admin/ip-rules` and
 * `/admin/access/restriction`.
 *
 * Why: the routes need the global database, crypto, settings, audit and security providers (sessions, role permissions, the
 * permission catalog) plus the staff link tokens of `StaffAuthModule`, the invitation and reset mails of `StaffMailModule`, the IP rule
 * cache of `IpRulesModule` and the sign-in lock (a temporary password set by staff lifts it, decision 052).
 */
@Module({
  imports: [StaffAuthModule, StaffMailModule, IpRulesModule, SignInLockModule],
  controllers: [StaffController, RolesController, SessionsController, IpRulesController],
  providers: [StaffAdminService, RoleAdminService, SessionAdminService, IpRuleAdminService],
})
export class AccessAdminModule {}
