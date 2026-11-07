// IpRuleAdminService: the use cases of the IP rule routes and the admin access restriction (map domain A, stage 2, scenario
// ip-rules): list, show, add, remove, test an address and switch the allow-list restriction. Every change that could lock the
// caller out is judged against the real request address, under a lock, before it is written.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { type IpAddress, networkContains, parseIpAddress, parseNetwork } from '../../../common/ip-address';
import { DbService, type TransactionContext } from '../../../infra/db';
import { AuditService, SettingsReader, SettingsService } from '../../platform';
import type { IpRule } from '../db/schema';
import { cidrToWire, normaliseCidr } from '../domain/ip-rule-input';
import {
  type IpRuleRow,
  deleteIpRuleRow,
  findIpRuleRow,
  findLiveDuplicate,
  insertIpRuleRow,
  listLiveIpRuleRows,
  lockIpRule,
  lockIpRuleChanges,
} from '../infra/ip-rule-admin.repository';
import type { IpAudience } from '../security/ip-rules/ip-audience';
import { ADMIN_ALLOWLIST_KEY, IpRuleCache } from '../security/ip-rules/ip-rule-cache';
import { compileIpRules, decideIpAccess } from '../security/ip-rules/ip-rule-matcher';
import { loadLiveIpRules } from '../security/ip-rules/ip-rule.repository';
import type { StaffPrincipal } from '../security/principal';

/** An IP rule as the console reads it. */
export interface IpRuleView {
  readonly id: number;
  readonly cidr: string;
  readonly label: string;
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly hitCount: number;
  readonly lastHitAt: string | null;
  readonly createdAt: string;
  readonly kind: IpRule['kind'];
  readonly scope: IpRule['scope'];
  readonly source: IpRule['source'];
  readonly createdBy: { id: number; name: string } | null;
}

/** The input of `POST /admin/ip-rules`. */
export interface CreateIpRuleInput {
  readonly kind: 'allow' | 'block';
  readonly scope: IpRule['scope'];
  readonly cidr: string;
  readonly label?: string | undefined;
  readonly reason?: string | undefined;
  readonly expiresAt?: string | undefined;
}

function toView({ rule, createdBy }: IpRuleRow): IpRuleView {
  return {
    id: rule.id,
    cidr: cidrToWire(rule.cidr),
    label: rule.label,
    reason: rule.reason,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    hitCount: rule.hitCount,
    lastHitAt: rule.lastHitAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    kind: rule.kind,
    scope: rule.scope,
    source: rule.source,
    createdBy,
  };
}

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

/**
 * Manages IP rules and the admin allow-list restriction.
 *
 * Why: scenario ip-rules. The pipeline judges every request by these rules before anything else, so a mistake here can lock
 * the whole team out. The guards (ANSWERS access, B6, B7): a block of the admin console or of everything that covers the
 * caller's own address is `SELF_LOCKOUT`; removing the allow rule that lets the caller in while the restriction is on is
 * `SELF_LOCKOUT`; turning the restriction on without a live allow rule for the caller's address is `IP_NOT_IN_ALLOWLIST`.
 * "The caller's address" is the real request address (`request.ip` behind the trusted proxy chain), never the console's hint.
 * The changes run under one advisory lock, so two staff members cannot lock each other out together.
 *
 * Side effects: writes `ip_rules`, the setting `adminAllowlistOnly` and `audit_logs`; clears the IP rule cache
 * (`IpRuleCache.invalidate()`) and the settings snapshot after the commit.
 *
 * @see docs/contract/endpoints/identity.md (the `/admin/ip-rules` and `/admin/access/restriction` sections)
 */
@Injectable()
export class IpRuleAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly settingsReader: SettingsReader,
    private readonly rulesCache: IpRuleCache,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the live rules.
   *
   * @param query the parsed list request
   * @returns the page and the exact total (expired rules are neither listed nor counted)
   */
  async list(
    query: ParsedListQuery<'createdAt' | 'hitCount' | 'expiresAt' | 'id'>,
  ): Promise<{ rows: IpRuleView[]; total: number }> {
    const { rows, total } = await listLiveIpRuleRows(this.db.db, query, this.clock.now());
    return { rows: rows.map(toView), total };
  }

  /**
   * Shows one rule, expired or not.
   *
   * @param id the rule id
   * @returns the rule
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<IpRuleView> {
    const row = await findIpRuleRow(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No IP rule has this id.' });
    return toView(row);
  }

  /**
   * Adds a rule.
   *
   * @param caller the signed-in staff member
   * @param input kind, audience, address or range, label, reason and expiry
   * @returns the new rule
   * @throws {AppError} `VALIDATION_FAILED` (422 on `cidr`, `reason` or `expiresAt`), `SELF_LOCKOUT` (409 on `cidr`)
   */
  async create(caller: StaffPrincipal, input: CreateIpRuleInput): Promise<IpRuleView> {
    const cidr = normaliseCidr(input.cidr);
    if (!cidr.ok) throw invalid('cidr', cidr.message);
    // An allow rule only ever opens the admin console (the dialogs cannot say otherwise; the mock forces it too).
    const scope = input.kind === 'allow' ? 'admin' : input.scope;
    const reason = input.reason ?? '';
    if (input.kind === 'block' && reason === '') throw invalid('reason', 'Say why this address is blocked.');
    const now = this.clock.now();
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      throw invalid('expiresAt', 'Pick a time in the future.');
    }

    const created = await this.db.runInTransaction(async (work) => {
      await lockIpRuleChanges(work.tx);
      const duplicate = await findLiveDuplicate(work.tx, { cidr: cidr.stored, kind: input.kind, scope }, now);
      if (duplicate) {
        throw invalid(
          'cidr',
          input.kind === 'allow'
            ? 'That address is already on the list.'
            : 'That address is already blocked for this audience.',
        );
      }
      const address = parseIpAddress(caller.ip);
      if (
        input.kind === 'block' &&
        (scope === 'admin' || scope === 'all') &&
        address !== undefined &&
        networkContains(cidr.network, address)
      ) {
        throw new AppError('SELF_LOCKOUT', {
          detail: 'This block would cover your own address, so you could not sign in again.',
          errors: [{ field: 'cidr', code: 'SELF_LOCKOUT', message: 'This range includes your own address.' }],
        });
      }
      const rule = await insertIpRuleRow(work.tx, {
        kind: input.kind,
        scope,
        cidr: cidr.stored,
        label: input.label ?? '',
        reason,
        expiresAt,
        createdBy: caller.staffId,
        // The console shows it: written from the clock, not the column default (decision 031).
        createdAt: now,
      });
      work.afterCommit(() => this.rulesCache.invalidate());
      await this.audit.record(work.tx, {
        action: input.kind === 'allow' ? 'allowed IP for the admin console' : 'blocked IP',
        entityType: 'ip_rule',
        entityId: rule.id,
        entityLabel: cidr.wire,
        after: {
          kind: rule.kind,
          scope: rule.scope,
          cidr: cidr.wire,
          label: rule.label,
          reason: rule.reason,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      });
      return rule.id;
    });
    return this.show(created);
  }

  /**
   * Removes a rule.
   *
   * @param caller the signed-in staff member
   * @param id the rule id
   * @throws {AppError} `NOT_FOUND` (404), `SELF_LOCKOUT` (409: the rule is the only live allow rule that lets the caller in
   *   while the restriction is on)
   */
  async remove(caller: StaffPrincipal, id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      await lockIpRuleChanges(work.tx);
      const rule = await lockIpRule(work.tx, id);
      if (!rule) throw new AppError('NOT_FOUND', { detail: 'No IP rule has this id.' });
      const now = this.clock.now();
      const live = rule.expiresAt === null || rule.expiresAt.getTime() > now.getTime();
      if (rule.kind === 'allow' && live && (await this.restricted(work.tx))) {
        const address = parseIpAddress(caller.ip);
        const network = parseNetwork(rule.cidr);
        if (address !== undefined && network !== undefined && networkContains(network, address)) {
          const verdict = await this.verdict(work.tx, address, true, now, id);
          if (verdict.decision === 'refused') {
            throw new AppError('SELF_LOCKOUT', {
              detail: 'This is the only allow rule that lets you in, and the restriction is on.',
              errors: [{ field: 'id', code: 'SELF_LOCKOUT', message: 'Removing it would lock you out.' }],
            });
          }
        }
      }
      await deleteIpRuleRow(work.tx, id);
      work.afterCommit(() => this.rulesCache.invalidate());
      await this.audit.record(work.tx, {
        action: rule.kind === 'allow' ? 'removed allowed IP' : 'unblocked IP',
        entityType: 'ip_rule',
        entityId: id,
        entityLabel: cidrToWire(rule.cidr),
        before: {
          kind: rule.kind,
          scope: rule.scope,
          cidr: cidrToWire(rule.cidr),
          label: rule.label,
          reason: rule.reason,
        },
      });
    });
  }

  /**
   * Tells what would happen to an address.
   *
   * @param input the address (or range, judged by its first address) and the audience
   * @returns `allowed` or `refused` and the rule that decided, if any
   * @throws {AppError} `VALIDATION_FAILED` (422 on `ip`)
   */
  async check(input: {
    ip: string;
    scope: IpRule['scope'];
  }): Promise<{ decision: 'allowed' | 'refused'; rule: IpRuleView | null }> {
    const network = parseNetwork(input.ip);
    if (!network) throw invalid('ip', 'Enter an IP address, or a range like 203.0.113.0/24.');
    // `all` has no audience of its own: only a block with scope `all` can answer it.
    const audience: IpAudience = input.scope === 'all' ? 'other' : input.scope;
    const rules = await this.rulesCache.get();
    const verdict = decideIpAccess(
      rules,
      { family: network.family, bytes: network.bytes },
      audience,
      this.clock.nowMs(),
    );
    const row = verdict.rule ? await findIpRuleRow(this.db.db, verdict.rule.id) : undefined;
    return { decision: verdict.decision, rule: row ? toView(row) : null };
  }

  /**
   * Turns the allow-list restriction of the admin console on or off.
   *
   * @param caller the signed-in staff member
   * @param enabled the wanted state
   * @returns the stored state
   * @throws {AppError} `IP_NOT_IN_ALLOWLIST` (409) when turning it on without a live allow rule for the caller's address
   */
  async setRestriction(caller: StaffPrincipal, enabled: boolean): Promise<{ enabled: boolean }> {
    await this.db.runInTransaction(async (work) => {
      await lockIpRuleChanges(work.tx);
      if (enabled) {
        const verdict = await this.verdict(work.tx, parseIpAddress(caller.ip), true, this.clock.now());
        if (verdict.decision === 'refused') {
          throw new AppError('IP_NOT_IN_ALLOWLIST', {
            detail: 'Your current address is not on the allow list. Add it first, then turn the restriction on.',
          });
        }
      }
      const before = await this.settings.set(work.tx, ADMIN_ALLOWLIST_KEY, enabled);
      work.afterCommit(() => this.rulesCache.invalidate());
      work.afterCommit(() => this.settingsReader.invalidate());
      await this.audit.record(work.tx, {
        action: enabled
          ? 'turned on the IP restriction for the admin console'
          : 'turned off the IP restriction for the admin console',
        entityType: 'setting',
        entityLabel: ADMIN_ALLOWLIST_KEY,
        before: { [ADMIN_ALLOWLIST_KEY]: before === true },
        after: { [ADMIN_ALLOWLIST_KEY]: enabled },
      });
    });
    return { enabled };
  }

  private async restricted(tx: TransactionContext['tx']): Promise<boolean> {
    return (await this.settings.get(ADMIN_ALLOWLIST_KEY, tx)) === true;
  }

  /** Judges an address for the admin console against the rules stored right now (inside the transaction). */
  private async verdict(
    tx: TransactionContext['tx'],
    address: IpAddress | undefined,
    restricted: boolean,
    now: Date,
    exceptRuleId?: number,
  ) {
    const rules = (await loadLiveIpRules(tx, now)).filter((rule) => rule.id !== exceptRuleId);
    return decideIpAccess(compileIpRules({ version: 'check', restricted, rules }), address, 'admin', now.getTime());
  }
}
