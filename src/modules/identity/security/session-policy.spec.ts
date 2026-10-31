// Unit tests of the session policy (decision 018): lifetimes per subject and stage, from settings with defaults.
import { describe, expect, it } from 'bun:test';
import type { SettingsReader } from '../../platform';
import { SESSION_DEFAULT_MINUTES, SESSION_SETTING_KEYS, SessionPolicy, isFullSession } from './session-policy';

const MINUTE = 60_000;
/** A policy over a settings reader that returns the given values when valid (a fake of the real validation). */
function policy(values: Record<string, unknown> = {}): SessionPolicy {
  const settings = {
    integers: (specs: Record<string, { fallback: number; min: number; max: number }>) =>
      Promise.resolve(
        Object.fromEntries(
          Object.entries(specs).map(([key, spec]) => {
            const value = values[key];
            const valid =
              typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max;
            return [key, valid ? value : spec.fallback];
          }),
        ),
      ),
  } as unknown as SettingsReader;
  return new SessionPolicy(settings);
}

describe('SessionPolicy', () => {
  it('uses the defaults of decision 018 when nothing is set', async () => {
    const p = policy();
    expect(await p.limits('staff')).toEqual({
      absoluteMs: 8 * 60 * MINUTE,
      idleMs: 30 * MINUTE,
      pendingMs: 10 * MINUTE,
    });
    expect(await p.limits('client')).toEqual({
      absoluteMs: 30 * 24 * 60 * MINUTE,
      idleMs: 7 * 24 * 60 * MINUTE,
      pendingMs: 10 * MINUTE,
    });
    expect(await p.limits('customer')).toEqual(await p.limits('client'));
  });

  it("reads each subject's own settings", async () => {
    const p = policy({
      [SESSION_SETTING_KEYS.staffAbsolute]: 60,
      [SESSION_SETTING_KEYS.staffIdle]: 5,
      [SESSION_SETTING_KEYS.clientAbsolute]: 120,
      [SESSION_SETTING_KEYS.customerIdle]: 15,
      [SESSION_SETTING_KEYS.pending]: 2,
    });
    expect(await p.limits('staff')).toEqual({ absoluteMs: 60 * MINUTE, idleMs: 5 * MINUTE, pendingMs: 2 * MINUTE });
    expect((await p.limits('client')).absoluteMs).toBe(120 * MINUTE);
    expect((await p.limits('client')).idleMs).toBe(SESSION_DEFAULT_MINUTES.clientIdle * MINUTE);
    expect((await p.limits('customer')).idleMs).toBe(15 * MINUTE);
  });

  it('gives a sign-in step the pending time and a full session the absolute time', async () => {
    const p = policy();
    expect(await p.lifetimeMs('staff', 'pending_totp')).toBe(10 * MINUTE);
    expect(await p.lifetimeMs('staff', 'pending_password')).toBe(10 * MINUTE);
    expect(await p.lifetimeMs('staff', 'pending_totp_setup')).toBe(10 * MINUTE);
    expect(await p.lifetimeMs('staff', 'active')).toBe(480 * MINUTE);
  });

  it('gives only full sessions an idle limit', async () => {
    const p = policy();
    expect(await p.idleMs('staff', 'active')).toBe(30 * MINUTE);
    expect(await p.idleMs('staff', 'pending_totp')).toBe(0);
    expect(isFullSession('active')).toBe(true);
    expect(isFullSession('pending_password')).toBe(false);
  });

  it('names its settings with the sessions. prefix', () => {
    expect(Object.values(SESSION_SETTING_KEYS).every((key) => key.startsWith('sessions.'))).toBe(true);
    expect(new Set(Object.values(SESSION_SETTING_KEYS)).size).toBe(7);
  });
});
