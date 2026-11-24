// HTTP controller of the file downloads (map domain G, stage 5): both routes answer 302 with the presigned link in `Location`.
import { Body, Controller, Header, Param, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { getRequestContext } from '../../../common/request-context';
import { FileAccessService } from '../application/file-access.service';
import { FileUploadService } from '../application/file-upload.service';
import { identityApi } from '../notifications/identity-api';
import {
  openAdminFile,
  openClientFile,
  uploadClientFile,
  STORE_UPLOAD_MAX_BYTES,
  uploadStoreFile,
} from '../contracts/files.contracts';

/**
 * The id of the signed-in caller of a merchant or storefront route, from the request context the session guards fill in.
 *
 * Why: the platform module may not import the identity module's decorators (identity imports platform: decision 032), and the
 * context carries exactly the actor type and id the guards authenticated. The staff download needs the caller's permissions too, which the
 * context does not hold: it reads the principal through `identityApi()` (decision 047).
 *
 * @param type the kind of caller the route is for
 * @returns the caller's id
 * @throws {AppError} `UNAUTHORIZED` (401) when the request was not authenticated as that kind of caller
 */
function callerOf(type: 'staff' | 'client' | 'customer'): number {
  const actor = getRequestContext()?.actor;
  if (actor?.type !== type) throw new AppError('UNAUTHORIZED');
  return actor.id;
}

/**
 * The file routes: downloads and merchant uploads.
 *
 * Why: the console renders a plain link to `GET /admin/files/:id` (an order's input or result file, an identity document stored earlier); the merchant portal
 * links to its own files. Downloads redirect to a link that expires after 5 minutes (B154). A merchant uploads the input of a File
 * service order and its bank transfer receipts through `POST /client/files` (B157).
 *
 * @route GET /admin/files/:id
 * @route GET /client/files/:id
 * @route POST /client/files
 * @route POST /store/v1/files
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
   * @param request the request, which carries the staff principal (decision 047: the kinds of record that use the file decide the permissions)
   * @param reply the reply, to set `Location`
   * @route GET /admin/files/:id
   */
  @Route(openAdminFile)
  async openForStaff(
    @Param() params: ParamsOf<typeof openAdminFile>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    // The platform module imports no other module (decision 032): identity's helpers are loaded late (the module-level cycle).
    const identity = await identityApi();
    const principal = identity.principalOf(request);
    if (principal?.kind !== 'staff') throw new AppError('UNAUTHORIZED');
    const url = await this.files.linkForStaff(
      { staffId: principal.staffId, permissions: principal.permissions },
      params.id,
    );
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
   * Stores a receipt for the signed-in storefront customer (feature 21).
   *
   * @param body the multipart body with the file part
   * @returns the stored file
   * @route POST /store/v1/files
   */
  @Route(uploadStoreFile)
  @Header('Cache-Control', 'no-store')
  uploadForCustomer(@Body() body: BodyOf<typeof uploadStoreFile>): Promise<ResultOf<typeof uploadStoreFile>> {
    return this.uploads.uploadForCustomer(
      callerOf('customer'),
      { filename: body.file.filename, mime: body.file.mime, data: body.file.data },
      STORE_UPLOAD_MAX_BYTES,
    );
  }
}
