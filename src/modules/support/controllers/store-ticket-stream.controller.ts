// HTTP controller of the ticket link's live stream (feature 28, route beyond the map: scripts/map-additions/28.mjs): the capability
// guard resolves the token like for the other ticket routes, then the hub answers the request with a server-sent event stream.
import { Controller, Inject, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ContractHeaders, type HeadersOf, type QueryOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { type CapKey, RealtimeHub, type StreamViewer, streamCursorOf } from '../../../infra/realtime';
import { CurrentPrincipal, type Principal } from '../../identity';
import { storeTicketStream } from '../contracts/ticket-live.contracts';
import { ticketStreamKey } from '../realtime/ticket-realtime.source';

/** The most open streams of one ticket link (a customer with a phone and a laptop, and a spare tab). */
export const MAX_STREAMS_PER_TICKET = 3;

/**
 * The live stream of a ticket page.
 *
 * Why: feature 28 (plan § 3.4, decision 037): a staff reply appears on the open ticket page at once. The token stays in the path like
 * on the three sibling routes: an `EventSource` cannot send a header, and a short-lived stream ticket would need a mint route and a Redis
 * key and would break the browser's own reconnect, while the token already is the page's URL. The API logs the route template, the hub
 * logs the viewer `ticket:<id>`, and the proxy's access log hides the token (`deploy/Caddyfile`). No `originCheck`: no cookie is
 * involved. Thin: the viewer is the ticket (no session, no default audience key), capped at 3 streams per ticket and the per-address cap.
 *
 * @route GET /store/v1/tickets/:token/stream
 */
@Controller()
export class StoreTicketStreamController {
  private readonly maxPerIp: number;

  constructor(
    private readonly hub: RealtimeHub,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.maxPerIp = config.realtime.maxPerIp;
  }

  /**
   * Opens the stream of the ticket the token resolved to.
   *
   * @param principal the holder of the ticket token
   * @param query `cursor`
   * @param headers `last-event-id`
   * @param request the request (the hub reads its id, route and close)
   * @param reply the reply the hub hijacks
   * @returns when the stream is live; it stays open
   * @throws {AppError} `NOT_FOUND` (no ticket token), `RATE_LIMITED` (429), `UNAVAILABLE` (503)
   * @route GET /store/v1/tickets/:token/stream
   */
  @Route(storeTicketStream)
  open(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof storeTicketStream>,
    @ContractHeaders() headers: HeadersOf<typeof storeTicketStream>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (principal?.kind !== 'capability' || principal.access !== 'ticket-token') throw new AppError('NOT_FOUND');
    const viewer: StreamViewer = {
      kind: 'ticket',
      id: principal.resourceId,
      sessionId: null,
      ip: principal.ip,
      name: '',
      permissions: [],
    };
    // The ticket's cap comes first: it is also the key of the `stream-connect` limiter (20 opens a minute per ticket).
    const caps: CapKey[] = [
      { key: ticketStreamKey(viewer.id), max: MAX_STREAMS_PER_TICKET },
      { key: `ip:${viewer.ip}`, max: this.maxPerIp },
    ];
    return this.hub.open({
      viewer,
      caps,
      request,
      reply,
      cursor: streamCursorOf(headers['last-event-id'], query.cursor),
    });
  }
}
