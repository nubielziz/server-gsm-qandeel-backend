// The registry of real-time sources (decision 037): each kind of live data registers itself once (the inbox in feature 27, support
// tickets in feature 28); the hub asks it for the source of a doorbell topic and for every source of a new stream.
import { Injectable } from '@nestjs/common';
import type { RealtimeSource } from './realtime.types';

/** The topic the hub handles itself (session ends and account changes); no source may take it. */
export const SESSION_TOPIC = 'session';

const TOPIC = /^[a-z][a-z0-9-]{0,31}$/;
const LETTER = /^[a-z]$/;

/**
 * The registered sources, in registration order.
 *
 * Why: the hub knows no table; a module that has live data registers a {@link RealtimeSource} in its `onModuleInit` (before the
 * API listens), and the composite cursor orders its parts by registration.
 */
@Injectable()
export class RealtimeSources {
  private readonly byTopic = new Map<string, RealtimeSource>();

  /**
   * Registers a source.
   *
   * @param source the source
   * @throws {Error} for a malformed or reserved topic, a cursor key that is not one lower-case letter, or a topic or cursor key
   *   that is taken (a programming error: the app must not start)
   */
  register(source: RealtimeSource): void {
    if (!TOPIC.test(source.topic) || source.topic === SESSION_TOPIC) {
      throw new Error(`"${source.topic}" cannot be a real-time topic`);
    }
    if (!LETTER.test(source.cursorKey))
      throw new Error(`The cursor key of "${source.topic}" must be one lower-case letter`);
    if (this.byTopic.has(source.topic)) throw new Error(`The real-time topic "${source.topic}" is registered twice`);
    if (this.all().some((other) => other.cursorKey === source.cursorKey)) {
      throw new Error(`The cursor key "${source.cursorKey}" of "${source.topic}" is taken`);
    }
    this.byTopic.set(source.topic, source);
  }

  /**
   * The source of a topic.
   *
   * @param topic a doorbell topic
   * @returns the source, or `undefined` for an unknown topic (the doorbell is ignored)
   */
  get(topic: string): RealtimeSource | undefined {
    return this.byTopic.get(topic);
  }

  /**
   * Every registered source.
   *
   * @returns the sources, in registration order
   */
  all(): RealtimeSource[] {
    return [...this.byTopic.values()];
  }
}
