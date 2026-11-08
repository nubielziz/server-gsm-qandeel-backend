// DisputeService: the use cases of the dispute routes (map stage 16): list, read with the evidence pack, submit evidence, accept the loss.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { AuditService, PdfRenderer, StoredFiles } from '../../platform';
import { wireUsd } from '../domain/b2c-money';
import { EVIDENCE_KEYS, MAX_EVIDENCE_NOTE_LENGTH, evidenceText } from '../domain/dispute-rules';
import { wholeCents } from '../domain/refund-rules';
import { loadSessionMoney } from '../infra/b2c-reads.repository';
import {
  type DisputeSortField,
  findDispute,
  listDisputeRows,
  lockDispute,
  updateDisputeIn,
} from '../infra/dispute.repository';
import { GATEWAY_HTTP_POLICY, type GatewayHttpPolicy } from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway } from '../infra/gateway.repository';
import { findOrderPayment, lockOrderPayment } from '../infra/order-payment.repository';
import { DisputeLedger } from './dispute-ledger';
import { type WireDispute, DisputeViews } from './dispute-views';
import { GatewayCredentialsVault } from './gateway-credentials';
import { StorefrontOrderPorts } from './storefront-ports';

const label = (id: number): string => `DP-${id}`;
const notFound = () => new AppError('NOT_FOUND', { detail: 'No dispute with this id.' });

/**
 * Answers card disputes.
 *
 * Why: scenario b2c-chargeback steps 4 to 7, ANSWERS refunds Q5 to Q8, M115: evidence only while the dispute waits for it and before its
 * deadline (judged on the injected clock); the chosen lines go to the gateway, then are kept as a PDF with the dispute; accepting the
 * loss posts one chargeback journal (guarded by `disputes.ledger_tx_id`, so a later `lost` event posts nothing) and does not block the
 * customer. Lock order: the payment, then the dispute, then the ledger accounts.
 *
 * Side effects: updates `disputes` and `payments`; stores a PDF file; calls the gateway on a submit; writes a ledger transaction on an
 * accept, order timeline lines and `audit_logs`.
 *
 * @see docs/contract/endpoints/money.md (GET /admin/disputes ... POST /admin/disputes/:id/accept)
 */
@Injectable()
export class DisputeService {
  constructor(
    private readonly db: DbService,
    private readonly views: DisputeViews,
    private readonly ledger: DisputeLedger,
    private readonly ports: StorefrontOrderPorts,
    private readonly audit: AuditService,
    private readonly pdf: PdfRenderer,
    private readonly files: StoredFiles,
    private readonly vault: GatewayCredentialsVault,
    private readonly http: OutboundHttp,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(GATEWAY_HTTP_POLICY) private readonly policy?: GatewayHttpPolicy,
  ) {}

  /**
   * Lists disputes.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<DisputeSortField>): Promise<{ rows: WireDispute[]; total: number }> {
    const { rows, total } = await listDisputeRows(this.db.db, query);
    return { rows: await this.views.build(this.db.db, rows, false), total };
  }

  /**
   * Reads one dispute with its evidence pack.
   *
   * @param id the dispute id
   * @returns the dispute, `evidence` and `strength` included
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<WireDispute> {
    const dispute = await findDispute(this.db.db, id);
    if (!dispute) throw notFound();
    return (await this.views.build(this.db.db, [dispute], true))[0]!;
  }

  /**
   * Submits evidence.
   *
   * @param staffId the staff member
   * @param id the dispute
   * @param input the pack keys staff chose and an optional note
   * @returns the dispute, `under_review`
   * @throws {AppError} `NOT_FOUND`; `DISPUTE_NOT_OPEN`, `EVIDENCE_DEADLINE_PASSED` (409); `VALIDATION_FAILED` (422, fields `items`,
   *   `note`); `GATEWAY_ERROR` (502) when the gateway refuses the evidence
   */
  async submitEvidence(
    staffId: number,
    id: number,
    input: { items: readonly string[]; note?: string | undefined },
  ): Promise<WireDispute> {
    const note = (input.note ?? '').trim();
    const problems = [];
    const keys = [...new Set(input.items)];
    if (keys.length === 0)
      problems.push({ field: 'items', code: 'required', message: 'Choose at least one line of evidence.' });
    if (note.length > MAX_EVIDENCE_NOTE_LENGTH) {
      problems.push({
        field: 'note',
        code: 'too_long',
        message: `Keep the note under ${MAX_EVIDENCE_NOTE_LENGTH} characters.`,
      });
    }
    const dispute = await findDispute(this.db.db, id);
    if (!dispute) throw notFound();
    this.assertOpen(dispute);
    const pack = await this.views.pack(this.db.db, dispute);
    const unknown = keys.filter((key) => !(EVIDENCE_KEYS as readonly string[]).includes(key));
    if (unknown.length > 0) {
      problems.push({
        field: 'items',
        code: 'unknown',
        message: `These lines are not in the pack: ${unknown.join(', ')}.`,
      });
    }
    if (problems.length > 0)
      throw new AppError('VALIDATION_FAILED', { detail: problems[0]!.message, errors: problems });
    const chosen = pack.items.filter((line) => keys.includes(line.key));
    const text = evidenceText(chosen, note);

    // The gateway is told first (outside any transaction): a refusal leaves the dispute as it was.
    const payment = await findOrderPayment(this.db.db, dispute.paymentId);
    const gateway = payment ? await findGateway(this.db.db, payment.gatewayId) : undefined;
    const driver = gateway ? driverFor(gateway.driver) : undefined;
    if (gateway && driver?.submitEvidence) {
      await driver.submitEvidence({ http: this.http, policy: this.policy }, this.vault.read(gateway), {
        disputeReference: dispute.gatewayDisputeId,
        text,
      });
    }
    const now = this.clock.now();
    const bytes = await this.pdf.render({
      title: 'Dispute evidence',
      subtitle: `${label(dispute.id)}  -  SF-${dispute.orderId ?? 0}`,
      createdAt: now,
      footer: 'GSM',
      blocks: [
        {
          kind: 'facts',
          rows: [
            ['Dispute', label(dispute.id)],
            ['Reason', dispute.reasonCode],
            ['Amount', `${dispute.amount} ${dispute.currency}`],
            ['Evidence due', dispute.evidenceDueAt.toISOString().slice(0, 10)],
          ],
        },
        { kind: 'space' },
        ...chosen.flatMap((line) => [
          { kind: 'heading' as const, text: line.title },
          { kind: 'text' as const, text: line.body },
        ]),
        ...(note === ''
          ? []
          : [
              { kind: 'heading' as const, text: 'Note' },
              { kind: 'text' as const, text: note },
            ]),
      ],
    });
    return this.db.runInTransaction(async ({ tx }) => {
      await lockOrderPayment(tx, dispute.paymentId);
      const locked = await lockDispute(tx, id);
      if (!locked) throw notFound();
      this.assertOpen(locked);
      const file = await this.files.store(tx, {
        ownerType: 'staff',
        ownerId: staffId,
        filename: `${label(id)}-evidence.pdf`,
        mime: 'application/pdf',
        bytes,
        area: 'disputes',
      });
      const done = await updateDisputeIn(tx, id, ['needs_response'], {
        status: 'under_review',
        submittedAt: now,
        evidenceFileIds: [...(locked.evidenceFileIds ?? []), file.id],
        updatedAt: now,
      });
      if (!done) throw new AppError('DISPUTE_NOT_OPEN', { detail: `${label(id)} no longer waits for evidence.` });
      if (done.orderId !== null) {
        await this.ports.get().addTimeline(
          tx,
          done.orderId,
          { type: 'staff', id: staffId },
          {
            type: 'dispute',
            message: `Evidence pack submitted for ${label(id)}`,
            data: { disputeId: id },
          },
        );
      }
      await this.audit.record(tx, {
        action: 'submitted evidence for',
        entityType: 'dispute',
        entityId: id,
        entityLabel: `${label(id)} on SF-${done.orderId ?? 0}`,
        before: { status: 'needs_response' },
        after: { status: 'under_review', items: keys },
      });
      return (await this.views.build(tx, [done], true))[0]!;
    });
  }

  /**
   * Accepts the loss of a dispute.
   *
   * @param staffId the staff member
   * @param id the dispute
   * @returns the dispute, `lost`
   * @throws {AppError} `NOT_FOUND`; `DISPUTE_NOT_OPEN` (409)
   */
  async accept(staffId: number, id: number): Promise<WireDispute> {
    return this.db.runInTransaction(async ({ tx }) => {
      const first = await findDispute(tx, id);
      if (!first) throw notFound();
      const payment = await lockOrderPayment(tx, first.paymentId);
      const locked = await lockDispute(tx, id);
      if (!locked || !payment) throw notFound();
      if (locked.status !== 'needs_response') {
        throw new AppError('DISPUTE_NOT_OPEN', { detail: `${label(id)} no longer waits for evidence.` });
      }
      const actor = { type: 'staff' as const, id: staffId };
      const lost = await this.ledger.lose(tx, locked, payment, actor);
      const session =
        lost.orderId === null ? undefined : (await loadSessionMoney(tx, [lost.orderId])).get(lost.orderId);
      const usd = wireUsd(
        Money.of(lost.amount),
        session ? { amount: payment.amount, grossUsd: session.grossAmount } : undefined,
        session?.fxRate ?? '1',
      );
      if (lost.orderId !== null) {
        await this.ports.get().addTimeline(tx, lost.orderId, actor, {
          type: 'dispute',
          message: `Dispute accepted, $${wholeCents(usd)} returned to the cardholder`,
          data: { disputeId: id },
        });
      }
      await this.audit.record(tx, {
        action: 'accepted dispute',
        entityType: 'dispute',
        entityId: id,
        entityLabel: `${label(id)} on SF-${lost.orderId ?? 0}`,
        before: { status: 'needs_response' },
        after: { status: 'lost' },
      });
      return (await this.views.build(tx, [lost], true))[0]!;
    });
  }

  private assertOpen(dispute: { id: number; status: string; evidenceDueAt: Date }): void {
    if (dispute.status !== 'needs_response') {
      throw new AppError('DISPUTE_NOT_OPEN', { detail: `${label(dispute.id)} no longer waits for evidence.` });
    }
    if (dispute.evidenceDueAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError('EVIDENCE_DEADLINE_PASSED', {
        detail: `The evidence deadline of ${label(dispute.id)} has passed.`,
      });
    }
  }
}
