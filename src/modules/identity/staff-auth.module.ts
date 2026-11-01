// The staff sign-in of the identity module (routes /admin/auth/*, stage 2): controller, use cases and the invite/reset token
// service that staff management (feature 2a) calls. Separate from SecurityModule so tests without a database can leave it out.
import { Module } from '@nestjs/common';
import { SignInLimiter } from './application/sign-in-limiter';
import { StaffAuthTokens } from './application/staff-auth-tokens';
import { StaffPasswordService } from './application/staff-password.service';
import { StaffSignInService } from './application/staff-sign-in.service';
import { TotpService } from './application/totp.service';
import { StaffAuthController } from './controllers/staff-auth.controller';

/**
 * Provides the staff sign-in routes and `StaffAuthTokens`.
 *
 * Why: the six `/admin/auth/*` routes need the global database, crypto, rate-limit and audit providers and the security stack
 * (sessions, cookies, CSRF); the module is exported to the rest of the app only through `index.ts`.
 */
@Module({
  controllers: [StaffAuthController],
  providers: [SignInLimiter, TotpService, StaffSignInService, StaffPasswordService, StaffAuthTokens],
  exports: [StaffAuthTokens],
})
export class StaffAuthModule {}
