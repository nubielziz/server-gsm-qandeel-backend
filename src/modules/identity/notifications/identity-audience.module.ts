// Registers identity's audience providers with the platform's registry (feature 23, plan section 5.3): staff and merchants. Loaded by the
// API (audience preview, send) and by the worker (fan-out, send-time check); DB-free at boot (the providers take a DbExecutor per call).
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NotificationAudiences } from '../../platform';
import { MerchantAudience } from './merchant-audience';
import { StaffAudience } from './staff-audience';

/**
 * Adds {@link StaffAudience} and {@link MerchantAudience} to {@link NotificationAudiences}.
 *
 * Why: platform imports no module (decision 032): the owner of `staff_users` and `clients` registers, like the support events.
 *
 * Side effects: registers two providers at boot.
 */
@Injectable()
export class IdentityAudienceRegistration implements OnModuleInit {
  constructor(
    private readonly audiences: NotificationAudiences,
    private readonly staff: StaffAudience,
    private readonly merchants: MerchantAudience,
  ) {}

  /** Registers the providers. */
  onModuleInit(): void {
    this.audiences.register(this.staff);
    this.audiences.register(this.merchants);
  }
}

/** Provides the staff and merchant audience providers and registers them. */
@Module({ providers: [StaffAudience, MerchantAudience, IdentityAudienceRegistration] })
export class IdentityAudienceModule {}
