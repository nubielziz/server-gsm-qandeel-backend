// HTTP controller of the file downloads (map domain G, stage 5): both routes answer 302 with the presigned link in `Location`.
import { Controller, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type ParamsOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { getRequestContext } from '../../../common/request-context';
import { FileAccessService } from '../application/file-access.service';
import { openAdminFile, openClientFile } from '../contracts/files.contracts';

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
 * The file download routes.
 *
 * Why: the console renders a plain link to `GET /admin/files/:id` (an order's input or result file, a KYC document); the merchant portal
 * links to its own files. Both redirect to a link that expires after 5 minutes (B154).
 *
 * @route GET /admin/files/:id
 * @route GET /client/files/:id
 */
@Controller()
export class FilesController {
  constructor(private readonly files: FileAccessService) {}

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
}
