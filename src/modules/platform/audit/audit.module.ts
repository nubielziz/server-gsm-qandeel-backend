// Global Nest module of the audit log (platform module): AuditService for every use case and the staff-write enforcement.
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditEnforcementInterceptor } from './audit-enforcement.interceptor';
import { AuditService } from './audit.service';

/**
 * Provides {@link AuditService} to every module and installs the audit enforcement for the HTTP routes.
 *
 * Why: any admin use case writes an audit row inside its transaction, and every staff mutation is checked once per request
 * (decision 018). The module needs no database or Redis provider (the transaction comes from the caller), so tests that
 * leave the infrastructure out still build the app.
 */
@Global()
@Module({
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditEnforcementInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
