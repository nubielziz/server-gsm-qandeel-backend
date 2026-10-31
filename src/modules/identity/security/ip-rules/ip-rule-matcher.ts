// IP rule matching (scenario ip-rules): which active rule decides for an address and an audience. Pure functions over a
// compiled rule set, so no query and no parsing runs per request; the "check an address" route reuses the same decision.
import { type IpAddress, type IpNetwork, networkContains, parseNetwork } from '../../../../common/ip-address';
import type { IpRuleKind, IpRuleScope } from '../../db/schema';
import type { IpAudience } from './ip-audience';

/**
 * An active IP rule as it is cached (JSON).
 *
 * Why: the hook needs only what decides a request; the full rows (label, reason, creator) are read by the admin routes.
 */
export interface ActiveIpRule {
  readonly id: number;
  readonly kind: IpRuleKind;
  readonly scope: IpRuleScope;
  /** Postgres `cidr` text: `203.0.113.24/32`, `203.0.113.0/24`, `2001:db8::/32`. */
  readonly cidr: string;
  /** ISO time after which the rule no longer counts; null = until removed. */
  readonly expiresAt: string | null;
}

/**
 * What the cache keeps: the active rules and the access-restriction switch, as of one load.
 *
 * Why: the verdict for `/admin` needs both (a block first, then the allowlist when the restriction is on), and both change
 * together with `IpRuleCache.invalidate()`.
 */
export interface IpRuleSnapshot {
  /** Changes with every load; lets the compiled form be reused while the cached snapshot is the same. */
  readonly version: string;
  /** `adminAllowlistOnly`: only addresses on a live allow rule may use the admin console. */
  readonly restricted: boolean;
  readonly rules: readonly ActiveIpRule[];
}

/**
 * A rule with its network parsed and its expiry as a number.
 *
 * Why: matching compares bytes and milliseconds; both are prepared once per snapshot.
 */
export interface CompiledIpRule {
  readonly rule: ActiveIpRule;
  readonly network: IpNetwork;
  readonly expiresAtMs: number | null;
}

/**
 * A snapshot ready to match against.
 *
 * Why: parsing every CIDR for every request would waste the cache; the compiled form is rebuilt only when the snapshot
 * changes.
 */
export interface CompiledIpRules {
  readonly version: string;
  readonly restricted: boolean;
  readonly rules: readonly CompiledIpRule[];
}

/**
 * Parses the networks of a snapshot.
 *
 * Why: parsing every CIDR for every request would waste the cache (scenario ip-rules step 4: matching happens in memory).
 *
 * @param snapshot the cached snapshot
 * @returns the compiled form; a rule whose `cidr` cannot be read is left out (Postgres only stores valid ones)
 */
export function compileIpRules(snapshot: IpRuleSnapshot): CompiledIpRules {
  const rules: CompiledIpRule[] = [];
  for (const rule of snapshot.rules) {
    const network = parseNetwork(rule.cidr);
    if (!network) continue;
    const expiresAtMs = rule.expiresAt === null ? null : Date.parse(rule.expiresAt);
    rules.push({ rule, network, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null });
  }
  return { version: snapshot.version, restricted: snapshot.restricted, rules };
}

/**
 * The verdict for one address and audience.
 *
 * Why: the same words as `POST /admin/ip-rules/check` (`decision`, `rule`) plus the reason, which the hook turns into the
 * 403 detail and the console into "Blocked", "Not on the allowlist", "Allowed by" or "Open".
 */
export type IpDecision =
  /** A block rule covers the address; `rule` is that block. */
  | { readonly decision: 'refused'; readonly rule: ActiveIpRule; readonly reason: 'blocked' }
  /** The admin console is restricted and no live allow rule covers the address. */
  | { readonly decision: 'refused'; readonly rule: null; readonly reason: 'not_listed' }
  /** The admin console is restricted and an allow rule covers the address; `rule` is that allow rule. */
  | { readonly decision: 'allowed'; readonly rule: ActiveIpRule; readonly reason: 'allowed' }
  /** No rule applies. */
  | { readonly decision: 'allowed'; readonly rule: null; readonly reason: 'open' };

/** The most specific live rule of a kind that covers the address (longest prefix; the lowest id on a tie). */
function bestMatch(
  rules: CompiledIpRules,
  kind: IpRuleKind,
  covers: (rule: ActiveIpRule) => boolean,
  address: IpAddress | undefined,
  nowMs: number,
): ActiveIpRule | null {
  if (!address) return null;
  let best: CompiledIpRule | undefined;
  for (const candidate of rules.rules) {
    const { rule, network, expiresAtMs } = candidate;
    if (rule.kind !== kind || !covers(rule)) continue;
    if (expiresAtMs !== null && expiresAtMs <= nowMs) continue;
    if (!networkContains(network, address)) continue;
    if (
      !best ||
      network.prefixLength > best.network.prefixLength ||
      (network.prefixLength === best.network.prefixLength && rule.id < best.rule.id)
    ) {
      best = candidate;
    }
  }
  return best?.rule ?? null;
}

/**
 * Decides whether an address may use an audience.
 *
 * Why: scenario ip-rules steps 3-6. (1) A live block rule with the audience's scope, or with scope `all`, that covers the
 * address refuses it. (2) For the admin console, when the restriction is on, the address needs a live allow rule; none
 * refuses it. (3) Otherwise it is let through. A rule past its `expiresAt` drops out by itself, without a reload. An address
 * that could not be read matches no rule: it passes everywhere except the restricted admin console.
 *
 * @param rules the compiled rules
 * @param address the client address (`undefined` when it could not be read)
 * @param audience the audience of the request
 * @param nowMs the current time in milliseconds
 * @returns the decision and the rule that made it
 */
export function decideIpAccess(
  rules: CompiledIpRules,
  address: IpAddress | undefined,
  audience: IpAudience,
  nowMs: number,
): IpDecision {
  const block = bestMatch(rules, 'block', (rule) => rule.scope === 'all' || rule.scope === audience, address, nowMs);
  if (block) return { decision: 'refused', rule: block, reason: 'blocked' };
  if (audience === 'admin' && rules.restricted) {
    // The routes only create allow rules with scope `admin`; a row with another scope (a manual edit) does not open the console.
    const allow = bestMatch(rules, 'allow', (rule) => rule.scope === 'admin' || rule.scope === 'all', address, nowMs);
    return allow
      ? { decision: 'allowed', rule: allow, reason: 'allowed' }
      : { decision: 'refused', rule: null, reason: 'not_listed' };
  }
  return { decision: 'allowed', rule: null, reason: 'open' };
}
