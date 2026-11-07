// HTTP controller of the Dhru Fusion surface (map domain D, stage 7, decision 026): the one route `POST /api/index.php`. Thin: the action,
// its parameters and the envelope are the DhruGateway's; the owners of the actions bound their handlers to it.
import { Body, Controller, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { DHRU_HEADERS, DhruGateway } from '../../../common/dhru';
import { AppError } from '../../../common/errors';
import { UploadedFile } from '../../../common/multipart';
import { CurrentPrincipal, type Principal } from '../../identity';
import { dhruEndpoint } from '../contracts/dhru.contracts';

/**
 * The Dhru endpoint.
 *
 * Why: decision 026: merchants connect their Dhru Fusion software to one URL with eight actions. The guard has already checked the
 * `username` and `apiaccesskey` (scope `dhru`, allowed addresses, the key's limit); this reads the `action` and the base64 `parameters`
 * (and the files of a multipart call) and lets the gateway answer. Every answer is HTTP 200 with the Dhru headers: a success here, an
 * error through the Dhru error formatter.
 *
 * @route POST /api/index.php
 */
@Controller()
export class DhruController {
  constructor(private readonly gateway: DhruGateway) {}

  /**
   * Runs one Dhru action.
   *
   * @param principal the API-key principal
   * @param body the form fields (or the multipart parts, or the JSON object) of the request
   * @param reply the reply, to set the Dhru headers
   * @returns the SUCCESS envelope, or the per-item body of a bulk action
   * @route POST /api/index.php
   */
  @Route(dhruEndpoint)
  async call(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof dhruEndpoint>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof dhruEndpoint>> {
    if (principal?.kind !== 'api-key') throw new AppError('UNAUTHORIZED', { detail: 'Authentication Failed' });
    void reply.headers({ ...DHRU_HEADERS });
    return this.gateway.execute({
      action: body.action ?? '',
      parameters: body.parameters,
      files: Object.values(body).filter((value): value is UploadedFile => value instanceof UploadedFile),
      caller: { clientId: principal.clientId, clientName: principal.clientName, keyId: principal.keyId },
    });
  }
}
