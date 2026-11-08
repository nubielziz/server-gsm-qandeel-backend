// Nest module that provides the one alert notifier (feature 12b): the API (rule switched off or deleted) and the worker (evaluation) share the same class.
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { AlertNotifier, NotificationAlertNotifier } from './application/alert-notifier';

/**
 * Provides {@link AlertNotifier} backed by the platform's notifications.
 *
 * Why: the alert evaluator (worker) and the alert rules service (API) both write alert messages. One module owns the binding, so Nest builds the notifier
 * once per process and a test that watches it sees every message, whichever of the two wrote it.
 */
@Module({
  imports: [NotificationDeliveryModule],
  providers: [{ provide: AlertNotifier, useClass: NotificationAlertNotifier }],
  exports: [AlertNotifier],
})
export class AlertNotifierModule {}
