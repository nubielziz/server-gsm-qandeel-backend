// PaymentGatewayService: the staff routes on payment gateways (map routes /admin/payment-gateways): list, read, add, change and
// delete, each write audited.
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { type DbExecutor, DbService } from '../../../infra/db';
import { isUniqueViolation } from '../../../infra/db/pg-errors';
import { ClientGroupDirectory } from '../../catalog';
import { AuditService } from '../../platform';
import type { NewPaymentGateway, PaymentGateway } from '../db/schema';
import { type GatewayFields, checkGatewayFields, secretHintOf } from '../domain/gateway-rules';
import { orderPaymentBaseAmounts } from '../infra/foreign-directory.repository';
import {
  type GatewaySortField,
  deleteGateway,
  findGateway,
  findGatewayByCode,
  gatewayIsUsed,
  insertGateway,
  listGatewayRows,
  topupVolumes,
  updateGateway,
} from '../infra/gateway.repository';
import { type WireGateway, gatewayToWire } from './billing-wire';
import { GatewayCredentialsVault } from './gateway-credentials';

/** The body of a new gateway as the contract hands it over (decimals as typed text). */
export interface CreateGatewayInput extends GatewayFields {
  readonly allowedGroupIds: readonly number[];
  readonly supportsRefunds: boolean;
  readonly supports3ds: boolean;
  readonly isManual: boolean;
  readonly isActive: boolean;
  readonly secret?: string | undefined;
  readonly webhookSecret?: string | undefined;
}

/** What a change may carry. */
export type UpdateGatewayInput = Partial<CreateGatewayInput>;

const DAY_MS = 86_400_000;
const refuse = (...errors: FieldError[]) => new AppError('VALIDATION_FAILED', { errors });
const notFound = () => new AppError('NOT_FOUND', { detail: 'No payment gateway has this id.' });
const codeTaken: FieldError = {
  field: 'code',
  code: 'taken',
  message: 'Another payment method already uses this code.',
};

/** The audit snapshot of a gateway: what staff change, never a secret. */
function snapshotOf(row: PaymentGateway): Record<string, unknown> {
  return {
    code: row.code,
    driver: row.driver,
    name: row.name,
    audience: row.audience,
    feePercent: row.feePercent,
    feeFixed: row.feeFixed,
    minAmount: row.minAmount,
    maxAmount: row.maxAmount,
    allowedGroupIds: row.allowedGroupIds,
    supportsRefunds: row.supportsRefunds,
    supports3ds: row.supports3ds,
    isManual: row.isManual,
    holdHours: row.holdHours,
    isActive: row.isActive,
    hasSecret: row.configEnc !== null,
    hasWebhookSecret: row.webhookSecretEnc !== null,
  };
}

/**
 * The audit phrase of a change.
 *
 * Why: the demo logs the switch as `turned on payment method` / `turned off payment method` (12-state-b2c.js `setGateway`) and any
 * other edit as a general change. Only a change that moved the switch and nothing else (no field, no new secret) is the switch.
 *
 * @param before the gateway before the change
 * @param after the gateway after it
 * @param secretsSent whether the request carried a new secret or webhook secret
 * @returns the audit action
 */
function changeAction(before: PaymentGateway, after: PaymentGateway, secretsSent: boolean): string {
  if (secretsSent || before.isActive === after.isActive) return 'changed payment method';
  const { isActive: _was, ...restBefore } = snapshotOf(before);
  const { isActive: _is, ...restAfter } = snapshotOf(after);
  if (!isDeepStrictEqual(restBefore, restAfter)) return 'changed payment method';
  return after.isActive ? 'turned on payment method' : 'turned off payment method';
}

/** The decimals of a request, as the 4-decimal text the column stores (the contract text is checked by the field rules first). */
const fixed = (text: string): string => Money.of(text).toWire();

/**
 * Reads and changes payment gateways.
 *
 * Why: staff set the fees, limits and merchant groups of each way to pay (Settings > Payment methods). The console's write-only
 * `secret` is the API credential (encrypted into `config_enc`), the optional `webhookSecret` the signing key (money-14), and the
 * answers carry only a hint (`••••` and the last four characters). The code never changes because it is part of the webhook
 * address (`/webhooks/payments/:gateway`). A gateway with any payment or invoice cannot be deleted (B70).
 *
 * Side effects: `create`, `update` and `delete` write `payment_gateways` and one audit row each.
 *
 * @see docs/contract/endpoints/money.md (GET|POST|PATCH|DELETE /admin/payment-gateways)
 */
@Injectable()
export class PaymentGatewayService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly vault: GatewayCredentialsVault,
    private readonly groups: ClientGroupDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists gateways.
   *
   * @param query the parsed list request
   * @returns the page (with `volume30d`) and the number matching the filters
   */
  async list(query: ParsedListQuery<GatewaySortField>): Promise<{ rows: WireGateway[]; total: number }> {
    const { rows, total } = await listGatewayRows(this.db.db, query);
    return { rows: await this.wireOf(this.db.db, rows), total };
  }

  /**
   * Reads one gateway.
   *
   * @param id the gateway id
   * @returns the gateway
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<WireGateway> {
    const row = await findGateway(this.db.db, id);
    if (!row) throw notFound();
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /**
   * Adds a gateway.
   *
   * @param input the request body
   * @returns the new gateway
   * @throws {AppError} `VALIDATION_FAILED` for a bad field, a code another gateway uses, or a group that does not exist
   */
  async create(input: CreateGatewayInput): Promise<WireGateway> {
    const errors = await this.problems(input, input.allowedGroupIds);
    if (errors.length > 0) throw refuse(...errors);
    const row = await this.db.runInTransaction(async ({ tx }) => {
      if (await findGatewayByCode(tx, input.code)) throw refuse(codeTaken);
      const now = this.clock.now();
      let created: PaymentGateway;
      try {
        created = await insertGateway(tx, {
          code: input.code,
          driver: input.driver,
          name: input.name,
          audience: input.audience as PaymentGateway['audience'],
          feePercent: input.feePercent,
          feeFixed: fixed(input.feeFixed),
          minAmount: fixed(input.minAmount),
          maxAmount: fixed(input.maxAmount),
          allowedGroupIds: [...input.allowedGroupIds],
          supportsRefunds: input.supportsRefunds,
          supports3ds: input.supports3ds,
          isManual: input.isManual,
          instructions: input.instructions,
          holdHours: input.holdHours,
          isActive: input.isActive,
          configEnc: input.secret ? this.vault.sealConfig(null, { secret: input.secret }, 0) : null,
          webhookSecretEnc: input.webhookSecret ? this.vault.sealWebhookSecret(input.webhookSecret) : null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        // Two requests with the same code passed the check above together: the unique index decides.
        if (isUniqueViolation(error)) throw refuse(codeTaken);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'added payment method',
        entityType: 'payment_gateway',
        entityId: created.id,
        entityLabel: created.name,
        after: snapshotOf(created),
      });
      return created;
    });
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /**
   * Changes a gateway.
   *
   * @param id the gateway id
   * @param input the fields to change
   * @returns the changed gateway
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` for an invalid merged gateway, a code change or a group that does not exist
   */
  async update(id: number, input: UpdateGatewayInput): Promise<WireGateway> {
    const row = await this.db.runInTransaction(async ({ tx }) => {
      const current = await findGateway(tx, id, true);
      if (!current) throw notFound();
      if (input.code !== undefined && input.code !== current.code) {
        throw refuse({
          field: 'code',
          code: 'immutable',
          message: 'The code of a payment method cannot change: it is part of its webhook address.',
        });
      }
      const merged: CreateGatewayInput = {
        code: current.code,
        driver: input.driver ?? current.driver,
        name: input.name ?? current.name,
        audience: input.audience ?? current.audience,
        feePercent: input.feePercent ?? current.feePercent,
        feeFixed: input.feeFixed ?? current.feeFixed,
        minAmount: input.minAmount ?? current.minAmount,
        maxAmount: input.maxAmount ?? current.maxAmount,
        holdHours: input.holdHours ?? current.holdHours,
        instructions: input.instructions ?? current.instructions,
        allowedGroupIds: input.allowedGroupIds ?? current.allowedGroupIds,
        supportsRefunds: input.supportsRefunds ?? current.supportsRefunds,
        supports3ds: input.supports3ds ?? current.supports3ds,
        isManual: input.isManual ?? current.isManual,
        isActive: input.isActive ?? current.isActive,
      };
      // Only the groups of this request are looked up: the ones already stored may have been deleted since.
      const errors = await this.problems(merged, input.allowedGroupIds ?? [], tx);
      if (errors.length > 0) throw refuse(...errors);
      const changes: Partial<NewPaymentGateway> = {
        driver: merged.driver,
        name: merged.name,
        audience: merged.audience as PaymentGateway['audience'],
        feePercent: merged.feePercent,
        feeFixed: fixed(merged.feeFixed),
        minAmount: fixed(merged.minAmount),
        maxAmount: fixed(merged.maxAmount),
        holdHours: merged.holdHours,
        instructions: merged.instructions,
        allowedGroupIds: [...merged.allowedGroupIds],
        supportsRefunds: merged.supportsRefunds,
        supports3ds: merged.supports3ds,
        isManual: merged.isManual,
        isActive: merged.isActive,
        updatedAt: this.clock.now(),
      };
      if (input.secret) changes.configEnc = this.vault.sealConfig(current.configEnc, { secret: input.secret }, id);
      if (input.webhookSecret) changes.webhookSecretEnc = this.vault.sealWebhookSecret(input.webhookSecret);
      const updated = await updateGateway(tx, id, changes);
      await this.audit.record(tx, {
        action: changeAction(current, updated, Boolean(input.secret || input.webhookSecret)),
        entityType: 'payment_gateway',
        entityId: id,
        entityLabel: updated.name,
        before: snapshotOf(current),
        after: snapshotOf(updated),
      });
      return updated;
    });
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /**
   * Deletes a gateway nobody has paid through.
   *
   * @param id the gateway id
   * @throws {AppError} `NOT_FOUND`; `GATEWAY_IN_USE` when a payment or an invoice references it
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const current = await findGateway(tx, id, true);
      if (!current) throw notFound();
      if (await gatewayIsUsed(tx, id)) {
        throw new AppError('GATEWAY_IN_USE', {
          detail: `${current.name} has payments or invoices: turn it off instead of deleting it.`,
        });
      }
      await deleteGateway(tx, id);
      await this.audit.record(tx, {
        action: 'removed payment method',
        entityType: 'payment_gateway',
        entityId: id,
        entityLabel: current.name,
        before: snapshotOf(current),
      });
    });
  }

  /** Every problem of a gateway: its fields, a code that is taken, and the requested groups that do not exist. */
  private async problems(
    fields: CreateGatewayInput,
    requestedGroupIds: readonly number[],
    db: DbExecutor = this.db.db,
  ): Promise<FieldError[]> {
    const errors = checkGatewayFields(fields);
    if (requestedGroupIds.length > 0) {
      const known = await this.groups.refsOf(db, requestedGroupIds);
      const missing = [...new Set(requestedGroupIds)].filter((groupId) => !known.has(groupId));
      if (missing.length > 0) {
        errors.push({
          field: 'allowedGroupIds',
          code: 'unknown',
          message: `No client group has the id ${missing.join(', ')}.`,
        });
      }
    }
    return errors;
  }

  /** The wire of gateways with their secret hints and 30-day volumes (two aggregate queries for the whole page). */
  private async wireOf(db: DbExecutor, rows: readonly PaymentGateway[]): Promise<WireGateway[]> {
    const ids = rows.map((row) => row.id);
    const since = new Date(this.clock.nowMs() - 30 * DAY_MS);
    const [topups, orders] = await Promise.all([topupVolumes(db, ids, since), orderPaymentBaseAmounts(db, ids, since)]);
    const volumes = new Map<number, Money>(
      [...topups].map(([gatewayId, total]) => [gatewayId, Money.of(total)] as const),
    );
    for (const { gatewayId, base } of orders) {
      volumes.set(gatewayId, (volumes.get(gatewayId) ?? Money.zero()).add(Money.of(base)));
    }
    return rows.map((row) =>
      gatewayToWire(row, secretHintOf(this.vault.read(row).secret), (volumes.get(row.id) ?? Money.zero()).toWire()),
    );
  }
}
