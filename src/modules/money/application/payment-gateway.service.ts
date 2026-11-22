// PaymentGatewayService: the staff routes on payment gateways (map routes /admin/payment-gateways): list, read, add, change and
// delete, each write audited; and, beyond the map (feature 32, B232), the catalog of ready-made methods and the logo of a method.
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { UploadedFile } from '../../../common/multipart';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { type DbExecutor, DbService } from '../../../infra/db';
import { isUniqueViolation } from '../../../infra/db/pg-errors';
import { ClientGroupDirectory } from '../../catalog';
import { type PermissionHolder, requireOwner } from '../../identity';
import { AuditService, PUBLIC_LOGO_MIN_SIDE, PUBLIC_MEDIA_PATH, PublicImages } from '../../platform';
import type { NewPaymentGateway, PaymentGateway } from '../db/schema';
import {
  GATEWAY_PRESETS,
  type GatewayPreset,
  presetOf,
  presetPinProblems,
  presetProblems,
} from '../domain/gateway-presets';
import {
  type GatewayFields,
  type WebhookSecretChange,
  changesAutomaticSetup,
  changesCredentials,
  checkGatewayFields,
  nextWebhookSecrets,
  secretHintOf,
} from '../domain/gateway-rules';
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
export interface CreateGatewayInput extends GatewayFields, WebhookSecretChange {
  readonly allowedGroupIds: readonly number[];
  readonly supportsRefunds: boolean;
  readonly supports3ds: boolean;
  readonly isManual: boolean;
  readonly isActive: boolean;
  readonly secret?: string | undefined;
  /** The key of the ready-made method this one is made from (feature 32); `undefined` for a custom method. Checked on create only. */
  readonly preset?: string | null | undefined;
}

/** What a change may carry. */
export type UpdateGatewayInput = Partial<CreateGatewayInput>;

const DAY_MS = 86_400_000;
const GATEWAY_OWNER_DETAIL = 'Only an owner can set up an automatic payment method or change its secrets.';
const refuse = (...errors: FieldError[]) => new AppError('VALIDATION_FAILED', { errors });
/** The webhook keys after a change, or the 422 when a second key would stand alone. */
const webhookSecretsAfter = (stored: readonly string[], change: WebhookSecretChange) => {
  const next = nextWebhookSecrets(stored, change);
  if ('field' in next) throw refuse(next);
  return next;
};
const notFound = () => new AppError('NOT_FOUND', { detail: 'No payment gateway has this id.' });
const codeTaken: FieldError = {
  field: 'code',
  code: 'taken',
  message: 'Another payment method already uses this code.',
};

/**
 * The audit snapshot of a gateway: what staff change, never a secret.
 *
 * @param row the gateway
 * @param webhookSecrets how many webhook secrets it keeps (24C: whether a second one is stored)
 */
function snapshotOf(row: PaymentGateway, webhookSecrets = 0): Record<string, unknown> {
  return {
    code: row.code,
    driver: row.driver,
    name: row.name,
    preset: row.preset,
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
    hasSecondaryWebhookSecret: webhookSecrets > 1,
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
 * @param secretsSent whether the request carried a new secret, webhook secret or second webhook secret
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
 * `secret` is the API credential (encrypted into `config_enc`), the optional `webhookSecret` the signing key (money-14) and, since 24C,
 * `secondaryWebhookSecret` a second one (a second endpoint, or rotation), and the answers carry only hints (`••••` and the last four
 * characters). The code never changes because it is part of the webhook
 * address (`/webhooks/payments/:gateway`). A gateway with any payment or invoice cannot be deleted (B70).
 *
 * Feature 32 (B232, decision 041): `presets` lists the catalog of ready-made methods; `create` takes an optional `preset` that must be a known,
 * available entry whose kind and driver the request keeps (the method remembers it in `payment_gateways.preset`, which never changes);
 * `uploadLogo` and `removeLogo` set the method's own public logo. No money rule is touched: a method made from a preset is an ordinary
 * gateway row.
 *
 * Side effects: `create`, `update` and `delete` write `payment_gateways` and one audit row each; `uploadLogo` stores one object under
 * `media/` and one `files` row (through `PublicImages`), sets `payment_gateways.logo_file_id` and writes an audit row; `removeLogo` clears it
 * and writes an audit row.
 *
 * @see docs/contract/endpoints/money.md (GET|POST|PATCH|DELETE /admin/payment-gateways, GET /admin/payment-gateway-presets, POST|DELETE
 *   /admin/payment-gateways/:id/logo)
 */
@Injectable()
export class PaymentGatewayService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly vault: GatewayCredentialsVault,
    private readonly groups: ClientGroupDirectory,
    private readonly images: PublicImages,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the catalog of ready-made payment methods.
   *
   * Why: the console's "Ready-made methods" section (feature 32): staff add a method from an entry in one step.
   *
   * @returns the entries in their fixed order (nothing is read from the database)
   */
  presets(): GatewayPreset[] {
    return GATEWAY_PRESETS.map((preset) => ({ ...preset }));
  }

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
   * @param caller the signed-in staff member (only an Owner adds an automatic method or sends a secret, decision 046)
   * @param input the request body
   * @returns the new gateway
   * @throws {AppError} `VALIDATION_FAILED` for a bad field, a code another gateway uses, a group that does not exist, a second webhook
   *   secret without a first, or a `preset` that is unknown (`preset` `unknown`), not available yet (`preset` `unavailable`), of another
   *   kind than `isManual` (`isManual` `preset_kind`) or of another driver (`driver` `preset_driver`); `FORBIDDEN` (403) for a
   *   caller who is not an Owner and adds an automatic method or sends a secret, after the validation and before any write
   */
  async create(caller: PermissionHolder, input: CreateGatewayInput): Promise<WireGateway> {
    const errors = [...(await this.problems(input, input.allowedGroupIds)), ...presetProblems(input)];
    if (errors.length > 0) throw refuse(...errors);
    // Decision 046: a method that confirms payments by itself, and the keys it is checked against, are set by an Owner.
    if (!input.isManual || changesCredentials(input)) requireOwner(caller, GATEWAY_OWNER_DETAIL);
    const { secrets } = webhookSecretsAfter([], input);
    const row = await this.db.runInTransaction(async ({ tx }) => {
      if (await findGatewayByCode(tx, input.code)) throw refuse(codeTaken);
      const now = this.clock.now();
      let created: PaymentGateway;
      try {
        created = await insertGateway(tx, {
          code: input.code,
          driver: input.driver,
          name: input.name,
          // `presetProblems` passed: the key is a catalog entry (or absent for a custom method).
          preset: presetOf(input.preset)?.key ?? null,
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
          webhookSecretEnc: secrets.length > 0 ? this.vault.sealWebhookSecrets(secrets) : null,
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
        after: snapshotOf(created, secrets.length),
      });
      return created;
    });
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /**
   * Changes a gateway.
   *
   * @param caller the signed-in staff member (only an Owner sends a secret, changes `isManual` of a method that is automatic before
   *   or after the change, or changes the driver of such a method, decision 046; `secondaryWebhookSecret: null` on a method with no
   *   second secret changes nothing and is not a change of secrets)
   * @param id the gateway id
   * @param input the fields to change
   * @returns the changed gateway
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` for an invalid merged gateway, a code change, a group that does not exist, a
   *   second webhook secret without a first, or (a method made from a preset) a merged `isManual` that is not the preset's kind
   *   (`isManual` `preset_kind`) or a merged `driver` that is not the preset's (`driver` `preset_driver`), checked before any write;
   *   `FORBIDDEN` (403) for a caller who is not an Owner and does one of the Owner-only changes above, after the validation
   */
  async update(caller: PermissionHolder, id: number, input: UpdateGatewayInput): Promise<WireGateway> {
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
      const errors = [
        ...(await this.problems(merged, input.allowedGroupIds ?? [], tx)),
        // A method made from a preset keeps the kind and the driver of its entry (the preset itself never changes).
        ...presetPinProblems(current.preset, merged),
      ];
      if (errors.length > 0) throw refuse(...errors);
      const stored = this.vault.read(current).webhookSecrets;
      // Decision 046: the secrets, the kind of an automatic method and its driver are set by an Owner.
      if (changesCredentials(input, stored) || changesAutomaticSetup(current, merged)) {
        requireOwner(caller, GATEWAY_OWNER_DETAIL);
      }
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
      const webhook = webhookSecretsAfter(stored, input);
      if (input.secret) changes.configEnc = this.vault.sealConfig(current.configEnc, { secret: input.secret }, id);
      if (webhook.changed) {
        changes.webhookSecretEnc = webhook.secrets.length > 0 ? this.vault.sealWebhookSecrets(webhook.secrets) : null;
      }
      const updated = await updateGateway(tx, id, changes);
      const secretsSent = Boolean(input.secret || input.webhookSecret) || input.secondaryWebhookSecret !== undefined;
      await this.audit.record(tx, {
        action: changeAction(current, updated, secretsSent),
        entityType: 'payment_gateway',
        entityId: id,
        entityLabel: updated.name,
        before: snapshotOf(current, stored.length),
        after: snapshotOf(updated, webhook.secrets.length),
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

  /**
   * Sets the uploaded logo of a payment method.
   *
   * Why: feature 32 (B232): a method of staff's own has no bundled logo, so staff upload one; it wins over the preset's logo. The picture is
   * checked, cleaned and stored first, outside the transaction (`PublicImages.store`: object, then the `files` row, as the listing picture,
   * but from 64 pixels on each side: a logo is small, and a wordmark is short);
   * then, under the gateway row's lock, the method points at it. A replaced logo's file stays (it is content-addressed and may be shared).
   *
   * @param id the gateway id
   * @param file the uploaded part `file`
   * @param staffId the staff member who uploads it (the owner of the `files` row)
   * @returns the gateway with its new `logoUrl`
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `file`: `empty`, `unsupported_type`, `corrupt`, `animated`, `too_small`,
   *   `too_large_dimensions`, `rotated`); `PAYLOAD_TOO_LARGE` (over 2 MiB); `UNAVAILABLE` (storage is down)
   */
  async uploadLogo(id: number, file: UploadedFile, staffId: number): Promise<WireGateway> {
    // No object or file row for a gateway that does not exist.
    if (!(await findGateway(this.db.db, id))) throw notFound();
    const image = await this.images.store(this.db.db, {
      bytes: file.data,
      filename: file.filename,
      staffId,
      minSide: PUBLIC_LOGO_MIN_SIDE,
    });
    const row = await this.db.runInTransaction(async ({ tx }) => {
      const current = await findGateway(tx, id, true);
      if (!current) throw notFound();
      const updated = await updateGateway(tx, id, { logoFileId: image.fileId, updatedAt: this.clock.now() });
      await this.audit.record(tx, {
        action: 'uploaded logo for',
        entityType: 'payment_gateway',
        entityId: id,
        entityLabel: current.name,
        before: { logo: await this.logoNameOf(tx, current.logoFileId) },
        after: { logo: image.name, width: image.width, height: image.height, size: image.size },
      });
      return updated;
    });
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /**
   * Removes the uploaded logo of a payment method.
   *
   * Why: feature 32; staff may take a wrong logo down. The stored file stays. It answers the same when there was no logo and is audited
   * either way (every staff write leaves an audit row).
   *
   * @param id the gateway id
   * @throws {AppError} `NOT_FOUND`
   */
  async removeLogo(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const current = await findGateway(tx, id, true);
      if (!current) throw notFound();
      if (current.logoFileId !== null) await updateGateway(tx, id, { logoFileId: null, updatedAt: this.clock.now() });
      await this.audit.record(tx, {
        action: 'removed logo of',
        entityType: 'payment_gateway',
        entityId: id,
        entityLabel: current.name,
        before: { logo: await this.logoNameOf(tx, current.logoFileId) },
        after: { logo: null },
      });
    });
  }

  /** The stored name of a logo (`<sha256>.<ext>`), or `null` when the method has none. */
  private async logoNameOf(db: DbExecutor, fileId: number | null): Promise<string | null> {
    if (fileId === null) return null;
    const url = (await this.images.urlsOf(db, [fileId])).get(fileId);
    return url === undefined ? null : url.slice(PUBLIC_MEDIA_PATH.length);
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

  /** The wire of gateways with their secret hints, 30-day volumes and logo paths (three aggregate queries for the whole page). */
  private async wireOf(db: DbExecutor, rows: readonly PaymentGateway[]): Promise<WireGateway[]> {
    const ids = rows.map((row) => row.id);
    const since = new Date(this.clock.nowMs() - 30 * DAY_MS);
    const [topups, orders, logos] = await Promise.all([
      topupVolumes(db, ids, since),
      orderPaymentBaseAmounts(db, ids, since),
      this.images.urlsOf(
        db,
        rows.map((row) => row.logoFileId),
      ),
    ]);
    const volumes = new Map<number, Money>(
      [...topups].map(([gatewayId, total]) => [gatewayId, Money.of(total)] as const),
    );
    for (const { gatewayId, base } of orders) {
      volumes.set(gatewayId, (volumes.get(gatewayId) ?? Money.zero()).add(Money.of(base)));
    }
    return rows.map((row) => {
      const credentials = this.vault.read(row);
      const hints = {
        secretHint: secretHintOf(credentials.secret),
        webhookSecretHint: secretHintOf(credentials.webhookSecrets[0]),
        secondaryWebhookSecretHint: secretHintOf(credentials.webhookSecrets[1]),
      };
      return gatewayToWire(
        row,
        hints,
        (volumes.get(row.id) ?? Money.zero()).toWire(),
        logos.get(row.logoFileId ?? 0) ?? null,
      );
    });
  }
}
