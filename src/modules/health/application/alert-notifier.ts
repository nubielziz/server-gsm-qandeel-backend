// The seam between the alert evaluator and the notification feature (12a): what the evaluator tells the notifier when an alert opens, repeats or closes,
// and the notifier that writes the messages as platform notifications in the alert's own transaction.
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import type { TransactionContext } from '../../../infra/db';
import { NotificationService } from '../../platform';
import type {
  AlertChannel,
  AlertComparator,
  AlertEvent,
  AlertRule,
  AlertSeverity,
  AlertSubjectType,
  AlertUnit,
} from '../db/schema';
import { type AlertMessageKind, messageVariables } from '../domain/alert-message';

/** What the notifier needs to word and route one message (ids and the rule's snapshot only: no secrets, no personal data). */
export interface AlertNotice {
  readonly alertId: number;
  readonly ruleId: number;
  readonly ruleName: string;
  readonly severity: AlertSeverity;
  /** The channels of the rule when the alert fired, repeated or closed: where the message goes (map: Telegram and email, once). */
  readonly channels: readonly AlertChannel[];
  readonly metric: string;
  readonly unit: AlertUnit | null;
  /** The value that fired the alert (for `fired`) or the value that closed it (for `resolved`). */
  readonly value: number;
  readonly threshold: number;
  readonly comparator: AlertComparator;
  readonly windowSeconds: number;
  readonly startedAt: Date;
  readonly subjectType: AlertSubjectType;
  readonly subjectLabel: string | null;
  /** A sentence only the evaluator knows: the accounts of a ledger mismatch, or why an alert closed (the rule was switched off, deleted...). */
  readonly detail: string | null;
}

/**
 * Builds the notice of an alert.
 *
 * @param rule the rule as it is now (its id and the channels the message goes to)
 * @param alert the alert (its snapshot gives the name, severity, metric, threshold, window and subject)
 * @param value the value to report: the one that fired the alert, or the one that closed it
 * @param detail what only the caller knows, or `null`
 * @returns the notice
 */
export function noticeOf(
  rule: Pick<AlertRule, 'id' | 'channels'>,
  alert: AlertEvent,
  value: number,
  detail: string | null,
): AlertNotice {
  return {
    alertId: alert.id,
    ruleId: rule.id,
    ruleName: alert.ruleName,
    severity: alert.severity,
    channels: rule.channels as AlertChannel[],
    metric: alert.metric,
    unit: alert.unit,
    value,
    threshold: Number(alert.threshold),
    comparator: alert.comparator,
    windowSeconds: alert.windowSeconds,
    startedAt: alert.startedAt,
    subjectType: alert.subjectType,
    subjectLabel: alert.subjectLabel,
    detail,
  };
}

/**
 * Sends the messages of alerts.
 *
 * Why: scenario system-alert steps 4 and 10: a message goes out once when a rule fires, again only after the reminder interval until a staff member
 * acknowledges the alert, and once when the alert closes. Every method takes the transaction that opens, reminds or closes the alert, so the
 * notification exists if and only if the alert change does: a page is never lost between the insert and the send. An implementation must not
 * commit or roll back that transaction; a failure of the database propagates and the whole change is retried by the next evaluation.
 */
export abstract class AlertNotifier {
  /** An alert opened: notify the rule's channels. */
  abstract fired(work: Pick<TransactionContext, 'tx'>, notice: AlertNotice): Promise<void>;
  /** A firing alert is still unacknowledged after another reminder interval: repeat the message (`round` counts the repeats from 1). */
  abstract reminded(work: Pick<TransactionContext, 'tx'>, notice: AlertNotice, round: number): Promise<void>;
  /** An alert closed (the value is back in range, or its rule was switched off or deleted): send the "resolved" message. */
  abstract resolved(work: Pick<TransactionContext, 'tx'>, notice: AlertNotice): Promise<void>;
}

/**
 * The notifier that writes alert messages as platform notifications.
 *
 * Why: feature 12a made one delivery path; this class is how an alert uses it. The recipients are the ops mailbox(es) and chat of the configuration
 * (`ALERTS_EMAIL_TO`, `ALERTS_TELEGRAM_CHAT_ID`, decision 013), the lead's choice because the map names none. One notification per channel of the rule
 * and occurrence: the dedupe key names the alert, the kind of message (and the reminder round) and the channel, so running the same step twice
 * writes nothing new. A channel with no configured recipient is recorded as a failed notification with the reason, and nothing is sent.
 *
 * Side effects: inserts `notifications` rows and their `notification.send` outbox events in the caller's transaction.
 */
@Injectable()
export class NotificationAlertNotifier extends AlertNotifier {
  constructor(
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  /** @inheritdoc */
  fired(work: Pick<TransactionContext, 'tx'>, notice: AlertNotice): Promise<void> {
    return this.send(work, 'fired', notice, 0);
  }

  /** @inheritdoc */
  reminded(work: Pick<TransactionContext, 'tx'>, notice: AlertNotice, round: number): Promise<void> {
    return this.send(work, 'reminder', notice, round);
  }

  /** @inheritdoc */
  resolved(work: Pick<TransactionContext, 'tx'>, notice: AlertNotice): Promise<void> {
    return this.send(work, 'resolved', notice, 0);
  }

  private async send(
    work: Pick<TransactionContext, 'tx'>,
    kind: AlertMessageKind,
    notice: AlertNotice,
    round: number,
  ): Promise<void> {
    const event = kind === 'resolved' ? 'alert.resolved' : 'alert.fired';
    const variables = messageVariables(kind, notice, round);
    for (const channel of notice.channels) {
      await this.notifications.enqueueToAddress(work, {
        event,
        channel,
        to: this.recipientOf(channel),
        noRecipientReason: `No alert recipient is configured for ${channel}.`,
        variables,
        dedupeKey: `alert-${notice.alertId}:${kind === 'reminder' ? `reminder-${round}` : kind}:${channel}`,
      });
    }
  }

  /** Where a channel's message goes: the configured addresses (one email to all) or chat; `undefined` when none is set. */
  private recipientOf(channel: AlertChannel): string | undefined {
    if (channel === 'email')
      return this.config.alerts.emailTo.length === 0 ? undefined : this.config.alerts.emailTo.join(',');
    return this.config.alerts.telegramChatId;
  }
}
