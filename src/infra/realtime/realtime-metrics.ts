// Prometheus metrics of the real-time layer (decision 037): the hub's connections, events, drops and delivery time (API registry),
// and the publisher's doorbells (API and worker registries). Labels are low-cardinality: surfaces, reasons, event and topic names.
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

/** Why the hub refused a stream (`realtime_connections_refused_total{reason}`). */
export type RefusalReason = 'disabled' | 'capacity' | 'rate' | 'session_cap' | 'ip_cap' | 'ticket_cap' | 'cap';

/**
 * The metrics of the hub (API process).
 *
 * Why: operations watch the open streams per surface, why they end or are refused, what is dropped and how long a change takes
 * from its commit to the write (plan § 3.4; `docs/OPERATIONS.md` "Live connections").
 */
export class RealtimeHubMetrics {
  readonly connections: Gauge<'surface'>;
  readonly subscriberUp: Gauge;
  readonly opened: Counter<'surface'>;
  readonly closed: Counter<'surface' | 'reason'>;
  readonly refused: Counter<'surface' | 'reason'>;
  readonly eventsSent: Counter<'event'>;
  readonly drops: Counter<'reason'>;
  readonly doorbellsReceived: Counter<'topic'>;
  readonly replays: Counter<'outcome'>;
  readonly delivery: Histogram;

  /** @param registry the process registry (`MetricsService.registry`) */
  constructor(registry: Registry) {
    const registers = [registry];
    this.connections = new Gauge({
      name: 'realtime_connections',
      help: 'Open live event streams, by surface.',
      labelNames: ['surface'],
      registers,
    });
    this.subscriberUp = new Gauge({
      name: 'realtime_subscriber_up',
      help: '1 while the real-time subscriber is subscribed to the doorbell channel, else 0.',
      registers,
    });
    this.opened = new Counter({
      name: 'realtime_connections_opened_total',
      help: 'Live event streams opened, by surface.',
      labelNames: ['surface'],
      registers,
    });
    this.closed = new Counter({
      name: 'realtime_connections_closed_total',
      help: 'Live event streams closed, by surface and reason.',
      labelNames: ['surface', 'reason'],
      registers,
    });
    this.refused = new Counter({
      name: 'realtime_connections_refused_total',
      help: 'Live event streams refused before they started, by surface and reason.',
      labelNames: ['surface', 'reason'],
      registers,
    });
    this.eventsSent = new Counter({
      name: 'realtime_events_sent_total',
      help: 'Events written to live streams, by event name.',
      labelNames: ['event'],
      registers,
    });
    this.drops = new Counter({
      name: 'realtime_drops_total',
      help: 'Streams dropped or frames and doorbells skipped, by reason.',
      labelNames: ['reason'],
      registers,
    });
    this.doorbellsReceived = new Counter({
      name: 'realtime_doorbells_received_total',
      help: 'Doorbells the real-time subscriber received, by topic.',
      labelNames: ['topic'],
      registers,
    });
    this.replays = new Counter({
      name: 'realtime_replays_total',
      help: 'Source positions of opened streams: fresh (no cursor), replayed, or resync (too much was missed).',
      labelNames: ['outcome'],
      registers,
    });
    this.delivery = new Histogram({
      name: 'realtime_delivery_seconds',
      help: 'Time from the doorbell (the publisher clock) to the write on a stream.',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers,
    });
  }
}

/**
 * The metrics of the publisher (API and worker processes).
 *
 * Why: a doorbell that cannot be published is lost (the clients heal through their reconnect and safety poll), so its failures
 * are counted where they happen.
 */
export class RealtimePublisherMetrics {
  readonly published: Counter<'topic'>;
  readonly failures: Counter<'topic'>;

  /** @param registry the process registry (`MetricsService.registry`) */
  constructor(registry: Registry) {
    this.published = new Counter({
      name: 'realtime_doorbells_published_total',
      help: 'Doorbells published on the real-time channel, by topic.',
      labelNames: ['topic'],
      registers: [registry],
    });
    this.failures = new Counter({
      name: 'realtime_publish_failures_total',
      help: 'Doorbells that could not be published (Redis down, too large), by topic.',
      labelNames: ['topic'],
      registers: [registry],
    });
  }
}
