// HTTP controller of the file downloads (map domain G, stage 5): both routes answer 302 with the presigned link in `Location`.
import { Body, Controller, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { getRequestContext } from '../../../common/request-context';
import { FileAccessService } from '../application/file-access.service';
import { FileUploadService } from '../application/file-upload.service';
import {
  openAdminFile,
  openClientFile,
  openV1File,
  uploadClientFile,
  uploadV1File,
} from '../contracts/files.contracts';

/**
 * The id of the signed-in caller of a session route, from the request context the session guards fill in.
 *
 * Why: the platform module may not import the identity module's decorators (identity imports platform: decision 032), and the
 * context carries exactly the actor type and id the guards authenticated.
 *
 * @param type the kind of caller the route is for
 * @returns the caller's id
 * @throws {AppError} `UNAUTHORIZED` (401) when the request was not authenticated as that kind of caller
 */
function callerOf(type: 'staff' | 'client'): number {
  const actor = getRequestContext()?.actor;
  if (actor?.type !== type) throw new AppError('UNAUTHORIZED');
  return actor.id;
}

/**
 * The file routes: downloads and merchant uploads.
 *
 * Why: the console renders a plain link to `GET /admin/files/:id` (an order's input or result file, a KYC document); the merchant portal
 * links to its own files. Downloads redirect to a link that expires after 5 minutes (B154). A merchant uploads the input of a File
 * service order, its KYC documents and its bank transfer receipts through `POST /client/files` (portal) or `POST /v1/files` (REST v1),
 * one code path (B157); the REST v1 key's merchant is the actor the guard put in the request context, like a portal session's.
 *
 * @route GET /admin/files/:id
 * @route GET /client/files/:id
 * @route POST /client/files
 * @route POST /v1/files
 * @route GET /v1/files/:id
 */
@Controller()
export class FilesController {
  constructor(
    private readonly files: FileAccessService,
    private readonly uploads: FileUploadService,
  ) {}

  /**
   * Redirects a staff member to a file.
   *
   * @param params the file id
   * @param reply the reply, to set `Location`
   * @route GET /admin/files/:id
   */
  @Route(openAdminFile)
  async openForStaff(
    @Param() params: ParamsOf<typeof openAdminFile>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const url = await this.files.linkForStaff(callerOf('staff'), params.id);
    reply.header('location', url).header('cache-control', 'no-store');
  }

  /**
   * Redirects a merchant to one of its own files.
   *
   * @param params the file id
   * @param reply the reply, to set `Location`
   * @route GET /client/files/:id
   */
  @Route(openClientFile)
  async openForMerchant(
    @Param() params: ParamsOf<typeof openClientFile>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const url = await this.files.linkForMerchant(callerOf('client'), params.id);
    reply.header('location', url).header('cache-control', 'no-store');
  }

  /**
   * Stores a file for the signed-in merchant (the portal).
   *
   * @param body the multipart body with the file part
   * @returns the stored file
   * @route POST /client/files
   */
  @Route(uploadClientFile)
  uploadForMerchant(@Body() body: BodyOf<typeof uploadClientFile>): Promise<ResultOf<typeof uploadClientFile>> {
    return this.uploads.upload(callerOf('client'), {
      filename: body.file.filename,
      mime: body.file.mime,
      data: body.file.data,
    });
  }

  /**
   * Stores a file for the merchant behind the API key.
   *
   * @param body the multipart body with the file part
   * @returns the stored file
   * @route POST /v1/files
   */
  @Route(uploadV1File)
  uploadForKey(@Body() body: BodyOf<typeof uploadV1File>): Promise<ResultOf<typeof uploadV1File>> {
    return this.uploads.upload(callerOf('client'), {
      filename: body.file.filename,
      mime: body.file.mime,
      data: body.file.data,
    });
  }

  /**
   * Redirects the merchant behind an API key to one of its own files.
   *
   * @param params the file id
   * @param reply the reply, to set `Location`
   * @route GET /v1/files/:id
   */
  @Route(openV1File)
  async openForKey(
    @Param() params: ParamsOf<typeof openV1File>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const url = await this.files.linkForMerchant(callerOf('client'), params.id);
    reply.header('location', url).header('cache-control', 'no-store');
  }
}
