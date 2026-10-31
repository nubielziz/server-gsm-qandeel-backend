// Session lifetimes (decision 018): how long a session of each subject and stage lives, from system settings with defaults.
// The settings are plain integers in minutes under the `sessions.` prefix; a missing or invalid value falls back to the default.
import { Injectable } from '@nestjs/common';
import { type IntegerSetting, SettingsReader } from '../../platform';
import type { SessionStage, SubjectType } from '../db/schema';

/**
 * The setting keys of the session lifetimes, in minutes.
 *
 * Why: decision 018 makes the lifetimes settings with defaults (ANSWERS: "staff sessions 8 h absolute, 30 min idle, pre-2FA
 * stage 10 min"). The keys follow the `area.snake_case` style of the other settings (`payments.auto_credit_delay_minutes`).
 * The settings route of feature 2a validates and writes them.
 */
export const SESSION_SETTING_KEYS = {
  staffAbsolute: 'sessions.staff_absolute_minutes',
  staffIdle: 'sessions.staff_idle_minutes',
  clientAbsolute: 'sessions.client_absolute_minutes',
  clientIdle: 'sessions.client_idle_minutes',
  customerAbsolute: 'sessions.customer_absolute_minutes',
  customerIdle: 'sessions.customer_idle_minutes',
  pending: 'sessions.pending_minutes',
} as const;

const MINUTES_PER_DAY = 24 * 60;
/** A lifetime must be at least a minute and at most a year. */
const BOUNDS = { min: 1, max: 365 * MINUTES_PER_DAY } as const;

/**
 * The default lifetimes in minutes.
 *
 * Why: decision 018: staff 8 hours absolute and 30 minutes idle; merchants and customers 30 days absolute and 7 days idle;
 * a pending sign-in step 10 minutes.
 */
export const SESSION_DEFAULT_MINUTES = {
  staffAbsolute: 8 * 60,
  staffIdle: 30,
  clientAbsolute: 30 * MINUTES_PER_DAY,
  clientIdle: 7 * MINUTES_PER_DAY,
  customerAbsolute: 30 * MINUTES_PER_DAY,
  customerIdle: 7 * MINUTES_PER_DAY,
  pending: 10,
} as const;

type SessionSettingKey = (typeof SESSION_SETTING_KEYS)[keyof typeof SESSION_SETTING_KEYS];
const spec = (fallback: number): IntegerSetting => ({ fallback, ...BOUNDS });
const SETTING_SPECS = {
  [SESSION_SETTING_KEYS.staffAbsolute]: spec(SESSION_DEFAULT_MINUTES.staffAbsolute),
  [SESSION_SETTING_KEYS.staffIdle]: spec(SESSION_DEFAULT_MINUTES.staffIdle),
  [SESSION_SETTING_KEYS.clientAbsolute]: spec(SESSION_DEFAULT_MINUTES.clientAbsolute),
  [SESSION_SETTING_KEYS.clientIdle]: spec(SESSION_DEFAULT_MINUTES.clientIdle),
  [SESSION_SETTING_KEYS.customerAbsolute]: spec(SESSION_DEFAULT_MINUTES.customerAbsolute),
  [SESSION_SETTING_KEYS.customerIdle]: spec(SESSION_DEFAULT_MINUTES.customerIdle),
  [SESSION_SETTING_KEYS.pending]: spec(SESSION_DEFAULT_MINUTES.pending),
} satisfies Record<SessionSettingKey, IntegerSetting>;

/** The lifetimes that apply to one subject type, in milliseconds. */
export interface SessionLimits {
  /** How long a full session lives from its creation. */
  readonly absoluteMs: number;
  /** How long a full session may sit unused. */
  readonly idleMs: number;
  /** How long a pending sign-in step lives. */
  readonly pendingMs: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * Tells whether a session stage is a full session.
 *
 * Why: only `active` sessions use the absolute and idle limits; the pending steps live for the short pending time.
 *
 * @param stage a session stage
 * @returns true for `active`
 */
export function isFullSession(stage: SessionStage): boolean {
  return stage === 'active';
}

/**
 * Reads the session lifetimes from the settings.
 *
 * Why: decision 018: "Lifetimes are settings": an admin can shorten the staff session without a deploy. The reader caches
 * the settings, and the session view caches what the policy decided for 60 seconds.
 *
 * Side effects: reads the cached settings snapshot (one cache read, one database read on a miss).
 *
 * @see docs/decisions/018-auth-sessions-csrf.md
 */
@Injectable()
export class SessionPolicy {
  constructor(private readonly settings: SettingsReader) {}

  /**
   * Returns the lifetimes of a subject type.
   *
   * @param subjectType staff, merchant (`client`) or storefront customer
   * @returns the absolute, idle and pending limits in milliseconds
   */
  async limits(subjectType: SubjectType): Promise<SessionLimits> {
    const minutes = await this.settings.integers(SETTING_SPECS);
    const ms = (key: SessionSettingKey): number => minutes[key] * MS_PER_MINUTE;
    const pendingMs = ms(SESSION_SETTING_KEYS.pending);
    switch (subjectType) {
      case 'staff':
        return {
          absoluteMs: ms(SESSION_SETTING_KEYS.staffAbsolute),
          idleMs: ms(SESSION_SETTING_KEYS.staffIdle),
          pendingMs,
        };
      case 'client':
        return {
          absoluteMs: ms(SESSION_SETTING_KEYS.clientAbsolute),
          idleMs: ms(SESSION_SETTING_KEYS.clientIdle),
          pendingMs,
        };
      case 'customer':
        return {
          absoluteMs: ms(SESSION_SETTING_KEYS.customerAbsolute),
          idleMs: ms(SESSION_SETTING_KEYS.customerIdle),
          pendingMs,
        };
    }
  }

  /**
   * Returns how long a new session of this subject and stage lives.
   *
   * @param subjectType the subject type
   * @param stage the stage the session starts in
   * @returns milliseconds from now: the pending time for a sign-in step, the absolute limit for a full session
   */
  async lifetimeMs(subjectType: SubjectType, stage: SessionStage): Promise<number> {
    const limits = await this.limits(subjectType);
    return isFullSession(stage) ? limits.absoluteMs : limits.pendingMs;
  }

  /**
   * Returns the idle limit that applies to a session.
   *
   * @param subjectType the subject type
   * @param stage the session's stage
   * @returns the idle limit in milliseconds, or `0` for a pending step (it has no idle limit, only its short lifetime)
   */
  async idleMs(subjectType: SubjectType, stage: SessionStage): Promise<number> {
    return isFullSession(stage) ? (await this.limits(subjectType)).idleMs : 0;
  }
}
