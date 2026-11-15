// HTTP controller of the live event streams (decision 037; routes beyond the map, scripts/map-additions/27.mjs): the session guard
// authenticates the request like any other, then the hub answers it with a server-sent event stream.
import { Controller, Inject, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ContractHeaders, type HeadersOf, type QueryOf, Route } from '../../../common/contract';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { RealtimeHub, streamCursorOf } from '../../../infra/realtime';
import { CurrentPrincipal } from '../security/access-state';
import type { Principal } from '../security/principal';
import { adminStream, clientStream, customerStream } from './stream.contracts';
import { type StreamLimits, streamCapsOf, streamViewerOf } from './stream-viewer';

type StreamQuery = QueryOf<typeof adminStream>;
type StreamHeaders = HeadersOf<typeof adminStream>;

/**
 * The live event stream of each signed-in surface.
 *
 * Why: decision 037: a notification appears at once, without a reload. Thin: the guard has authenticated the session (and its
 * stage, account state, IP rules and same-site origin); the handler maps the principal to a viewer and its caps and hands the
 * request to the hub, which refuses it (problem+json) or answers with the stream itself (the reply is hijacked: `@Res()`).
 *
 * @route GET /admin/stream
 * @route GET /client/stream
 * @route GET /store/v1/me/stream
 */
@Controller()
export class StreamController {
  private readonly limits: StreamLimits;

  constructor(
    private readonly hub: RealtimeHub,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limits = config.realtime;
  }

  /**
   * The staff member's stream.
   *
   * @param principal the signed-in staff member
   * @param query `locale` and `cursor`
   * @param headers `last-event-id`
   * @param request the request (the hub reads its id, route and close)
   * @param reply the reply the hub hijacks
   * @returns when the stream is live; it stays open
   * @throws {AppError} `RATE_LIMITED` (429), `UNAVAILABLE` (503)
   * @route GET /admin/stream
   */
  @Route(adminStream)
  admin(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: StreamQuery,
    @ContractHeaders() headers: StreamHeaders,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.open(principal, query, headers, request, reply);
  }

  /**
   * The merchant's stream (also while the merchant waits for approval).
   *
   * @param principal the signed-in merchant
   * @param query `locale` and `cursor`
   * @param headers `last-event-id`
   * @param request the request
   * @param reply the reply the hub hijacks
   * @returns when the stream is live; it stays open
   * @throws {AppError} `RATE_LIMITED` (429), `UNAVAILABLE` (503)
   * @route GET /client/stream
   */
  @Route(clientStream)
  client(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof clientStream>,
    @ContractHeaders() headers: HeadersOf<typeof clientStream>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.open(principal, query, headers, request, reply);
  }

  /**
   * The customer's stream.
   *
   * @param principal the signed-in customer
   * @param query `locale` and `cursor`
   * @param headers `last-event-id`
   * @param request the request
   * @param reply the reply the hub hijacks
   * @returns when the stream is live; it stays open
   * @throws {AppError} `RATE_LIMITED` (429), `UNAVAILABLE` (503)
   * @route GET /store/v1/me/stream
   */
  @Route(customerStream)
  customer(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof customerStream>,
    @ContractHeaders() headers: HeadersOf<typeof customerStream>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.open(principal, query, headers, request, reply);
  }

  private open(
    principal: Principal | undefined,
    query: StreamQuery,
    headers: StreamHeaders,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const viewer = streamViewerOf(principal, query.locale);
    return this.hub.open({
      viewer,
      caps: streamCapsOf(viewer, this.limits),
      request,
      reply,
      cursor: streamCursorOf(headers['last-event-id'], query.cursor),
    });
  }
}
