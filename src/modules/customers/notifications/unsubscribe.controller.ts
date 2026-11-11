// HTTP controller of the marketing unsubscribe link (feature 23, route POST /store/v1/marketing/unsubscribe/:token).
import { Controller, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type ParamsOf, Route } from '../../../common/contract';
import { requestMetaOf } from '../../identity';
import { MarketingUnsubscribe } from './marketing-unsubscribe.service';
import { unsubscribeMarketing } from './unsubscribe.contracts';

/**
 * The unsubscribe route of marketing emails.
 *
 * Why: O3 and RFC 8058: a marketing email to a customer carries the link and the one-click `List-Unsubscribe` header; both reach this
 * route, which has no session (the token is the credential). Thin layer over {@link MarketingUnsubscribe}.
 *
 * @route POST /store/v1/marketing/unsubscribe/:token
 */
@Controller()
export class UnsubscribeController {
  constructor(private readonly unsubscribing: MarketingUnsubscribe) {}

  /**
   * Stops marketing email for the customer the token names.
   *
   * @param params the token of the link
   * @param request the request (its address and user agent go into the consent record)
   * @returns nothing (204)
   * @route POST /store/v1/marketing/unsubscribe/:token
   */
  @Route(unsubscribeMarketing)
  unsubscribe(@Param() params: ParamsOf<typeof unsubscribeMarketing>, @Req() request: FastifyRequest): Promise<void> {
    return this.unsubscribing.unsubscribe(params.token, requestMetaOf(request));
  }
}
