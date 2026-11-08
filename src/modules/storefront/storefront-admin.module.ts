// The staff routes of the storefront module (stage 16): the policies. Separate from StorefrontModule so a test app built without a database can
// leave it out.
import { Module } from '@nestjs/common';
import { StorefrontSettingsService } from './application/storefront-settings.service';
import { StorefrontSettingsController } from './controllers/storefront-settings.controller';

/**
 * Provides `PATCH /admin/storefront/settings`.
 *
 * Why: the use case needs the global database, settings and audit providers, which a database-less test app does not have.
 */
@Module({ controllers: [StorefrontSettingsController], providers: [StorefrontSettingsService] })
export class StorefrontAdminModule {}
