// Nest module of the upload-session pipeline stage (identity module, decision 053). API process only.
import { Module } from '@nestjs/common';
import { SecurityModule } from './security.module';
import { UploadSessionHook } from './upload-session.hook';

/**
 * Provides {@link UploadSessionHook} and registers the `upload-session` stage with the request pipeline.
 *
 * Why: decision 053. The stage needs the session authenticator of the security stack and the global pipeline and rate-limit modules,
 * which the API's root module imports; the worker has no HTTP surface and does not import it.
 */
@Module({
  imports: [SecurityModule],
  providers: [UploadSessionHook],
})
export class UploadSessionModule {}
