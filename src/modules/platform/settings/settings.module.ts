// Global Nest module of the cached settings reader (platform module). Shared by every module that needs a setting.
import { Global, Module } from '@nestjs/common';
import { SettingsReader } from './settings-reader';

/**
 * Provides {@link SettingsReader} to every module.
 *
 * Why: other modules may not read the `settings` table (the platform module owns it): identity reads the session lifetimes,
 * the pipeline hooks read the allowlist switch and maintenance. It needs the global database, cache and cache-key providers.
 */
@Global()
@Module({ providers: [SettingsReader], exports: [SettingsReader] })
export class SettingsModule {}
