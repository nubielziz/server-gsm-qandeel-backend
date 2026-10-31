// Global Nest module of the settings readers (platform module). Shared by every module that needs a setting.
import { Global, Module } from '@nestjs/common';
import { SettingsReader } from './settings-reader';
import { SettingsService } from './settings.service';

/**
 * Provides {@link SettingsReader} and {@link SettingsService} to every module.
 *
 * Why: other modules may not read the `settings` table (the platform module owns it). `SettingsReader` is the cached
 * read for hot paths (identity reads the session lifetimes on every request); `SettingsService` reads the table directly
 * (optionally inside a transaction) for code that caches a derived snapshot itself (the IP rules and maintenance
 * caches). A settings write invalidates `SettingsReader` and the derived caches after its commit.
 */
@Global()
@Module({ providers: [SettingsReader, SettingsService], exports: [SettingsReader, SettingsService] })
export class SettingsModule {}
