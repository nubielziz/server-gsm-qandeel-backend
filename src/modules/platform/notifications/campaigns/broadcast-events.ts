// The notification events of the notification center (feature 23, plan section 4): `broadcast.announcement` for the email and Telegram
// rows of a campaign, `broadcast.test` for a campaign's test to its author. Registered at boot, not part of BUILT_IN_EVENTS.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type NotificationEventDefinition, NotificationEventRegistry } from '../notification-events';

/** The event of a campaign's email and Telegram rows. */
export const BROADCAST_ANNOUNCEMENT_EVENT = 'broadcast.announcement';
/** The event of a campaign's test message to its author. */
export const BROADCAST_TEST_EVENT = 'broadcast.test';

const announcement = {
  key: BROADCAST_ANNOUNCEMENT_EVENT,
  label: 'Announcements',
  description: 'Announcements and offers staff send from the notification center.',
  variables: [],
  sample: {},
  templated: false,
} as const;

/**
 * The events of the notification center.
 *
 * Why: every `notifications` row names a registered event. The merchant event is not transactional and defaults to email and
 * Telegram on (O4, O11), so it appears in the merchant's preferences and the switches decide; the customer event is not
 * transactional (a suspended customer gets no announcement); the staff events are. None has a template (`templated: false`): the
 * campaign writes its own text.
 */
export const BROADCAST_EVENTS: readonly NotificationEventDefinition[] = [
  {
    ...announcement,
    audience: 'merchant',
    channels: ['email', 'telegram'],
    transactional: false,
    defaultEmail: true,
    defaultTelegram: true,
  },
  {
    ...announcement,
    audience: 'customer',
    channels: ['email'],
    transactional: false,
    defaultEmail: true,
    defaultTelegram: false,
  },
  {
    ...announcement,
    audience: 'staff',
    channels: ['email'],
    transactional: true,
    defaultEmail: false,
    defaultTelegram: false,
  },
  {
    key: BROADCAST_TEST_EVENT,
    audience: 'staff',
    label: 'Campaign test',
    description: 'The test of a campaign that staff send to themselves before sending it.',
    channels: ['email'],
    variables: ['title', 'body'],
    sample: { title: 'Scheduled maintenance on Friday', body: 'The portal will be read-only from 02:00 to 03:00 UTC.' },
    transactional: true,
    defaultEmail: false,
    defaultTelegram: false,
    templated: false,
  },
];

/**
 * Registers {@link BROADCAST_EVENTS}.
 *
 * Why: the API (template routes, preferences, the test send) and the worker (the delivery) look events up in their own registry,
 * so both load this provider through the global `NotificationEventsModule`.
 *
 * Side effects: adds four events to the registry at boot.
 */
@Injectable()
export class BroadcastEvents implements OnModuleInit {
  constructor(private readonly registry: NotificationEventRegistry) {}

  /** Adds the events. */
  onModuleInit(): void {
    for (const definition of BROADCAST_EVENTS) this.registry.register(definition);
  }
}
