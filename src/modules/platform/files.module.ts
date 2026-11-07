// The merchants' file upload as a global provider, so the orders module (a Dhru file order) uploads through the same code as the file routes.
import { Global, Module } from '@nestjs/common';
import { FileUploadService } from './application/file-upload.service';

/**
 * Provides {@link FileUploadService} to every module.
 *
 * Why: B157: `POST /v1/files`, `POST /client/files` and the Dhru file order store a merchant's file the same way. It needs the database
 * and object storage, which a database-less test app does not have, so it is imported by `PlatformAdminModule`, which such an app leaves
 * out.
 */
@Global()
@Module({ providers: [FileUploadService], exports: [FileUploadService] })
export class FilesModule {}
