// The IP rules stage of the request pipeline (decision 018, scenario ip-rules): blocks first, then the admin allowlist; a
// refused request answers 403 IP_NOT_ALLOWED before authentication, with the CORS headers.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../../common/clock';
import { type IpAddress, formatIpAddress, parseIpAddress } from '../../../../common/ip-address';
import { AppError } from '../../../../common/errors';
import { RequestPipeline, requestPath } from '../../../../common/pipeline';
import { ipAudienceOf } from './ip-audience';
import { IpRuleCache } from './ip-rule-cache';
import { IpRuleHits } from './ip-rule-hits';
import { decideIpAccess } from './ip-rule-matcher';

/**
 * Reads the client address of a request.
 *
 * Why: `request.ip` is the socket address, or the address a trusted proxy reported when `TRUST_PROXY` is set (Fastify
 * decides; decision 018 says rules judge the real request IP). It is parsed so that a mapped IPv6 form matches the IPv4
 * rule, and so that text which is not an address never reaches a message or a key.
 *
 * @param request the request
 * @returns the address, or `undefined` when it could not be read
 */
export function clientAddressOf(request: Pick<FastifyRequest, 'ip'>): IpAddress | undefined {
  return typeof request.ip === 'string' ? parseIpAddress(request.ip) : undefined;
}

/** The sentence for a refused address; names the address the server saw, which helps staff and customers fix a VPN. */
function refusalDetail(reason: 'blocked' | 'not_listed', address: IpAddress | undefined): string {
  const who = address ? `Your network address (${formatIpAddress(address)})` : 'Your network address';
  return reason === 'not_listed'
    ? `${who} is not on the list of addresses allowed to use the admin console.`
    : `${who} is blocked.`;
}

/**
 * Registers the IP rules stage with the pipeline.
 *
 * Why: the first check after CORS and the request id (decision 018): a live block rule for the request's audience (or for
 * all) refuses it; for the admin console, when the restriction is on, an address without a live allow rule is refused too.
 * The refusal is `403 IP_NOT_ALLOWED`, a session-ending code about the caller only (ALIGNMENT § 3), decided before
 * authentication so a blocked address learns nothing about accounts. The decision counts a hit on the rule that made it.
 * `/health` and `/metrics` are never judged.
 *
 * Failure policy: if the rules cannot be read at all (a cold start with Postgres down), the request is refused with
 * `503 DATABASE_UNAVAILABLE`: a rule that cannot be checked is not skipped.
 *
 * Side effects: counts a hit in Redis (`IpRuleHits.record`) for the rule that decided.
 *
 * @see docs/contract/endpoints/identity.md (`POST /admin/ip-rules/check` answers the same decision)
 */
@Injectable()
export class IpRulesHook implements OnModuleInit {
  constructor(
    private readonly pipeline: RequestPipeline,
    private readonly rules: IpRuleCache,
    private readonly hits: IpRuleHits,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the stage. */
  onModuleInit(): void {
    this.pipeline.register('ip-rules', (request) => this.handle(request));
  }

  /**
   * Judges one request.
   *
   * @param request the request
   * @throws {AppError} `IP_NOT_ALLOWED` for a blocked or unlisted address; `DATABASE_UNAVAILABLE` when the rules cannot be read
   */
  async handle(request: FastifyRequest): Promise<void> {
    const audience = ipAudienceOf(requestPath(request));
    if (audience === undefined) return;
    const rules = await this.rules.get().catch((cause: unknown) => {
      throw new AppError('DATABASE_UNAVAILABLE', {
        detail: 'Network access rules cannot be checked right now. Try again shortly.',
        cause,
      });
    });
    const address = clientAddressOf(request);
    const nowMs = this.clock.nowMs();
    const verdict = decideIpAccess(rules, address, audience, nowMs);
    if (verdict.rule) this.hits.record(verdict.rule.id, nowMs);
    if (verdict.decision === 'refused') {
      throw new AppError('IP_NOT_ALLOWED', { detail: refusalDetail(verdict.reason, address) });
    }
  }
}
