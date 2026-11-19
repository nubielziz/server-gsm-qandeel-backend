// Unit tests of the state rules of the moves staff make on a publish run (feature 31, plan 31 section 5.2): the table of apply (first
// apply, resume and every refusal), who may cancel what, and when the run switch is allowed.
import { describe, expect, it } from 'bun:test';
import type { PublishRunStatus, PublishSwitchStatus } from '../../db/schema';
import { PUBLISH_STALE_MS } from './publish-item';
import {
  type CopiedRun,
  type MovedRun,
  type ReplacementRun,
  applyVerdict,
  cancelVerdict,
  copyVerdict,
  switchVerdict,
} from './publish-moves';

const NOW = Date.parse('2026-11-18T10:00:00.000Z');
const FRESH = new Date(NOW - 1_000);
const OLD = new Date(NOW - PUBLISH_STALE_MS - 1_000);
const PREPARED = new Date(NOW - 3_600_000);

function run(status: PublishRunStatus, overrides: Partial<MovedRun> = {}): MovedRun {
  return { status, heartbeatAt: FRESH, preparedAt: PREPARED, switchStatus: null, ...overrides };
}

const switchOf = (switchStatus: PublishSwitchStatus, heartbeatAt: Date) => ({ switchStatus, heartbeatAt });

describe('copyVerdict', () => {
  const REPLACED = 'That preview was already replaced by a newer one.';
  const NOT_FINISHED = 'The preview was not finished. Start a new one.';

  function earlier(status: PublishRunStatus, overrides: Partial<CopiedRun> = {}): CopiedRun {
    return { status, heartbeatAt: FRESH, preparedAt: PREPARED, replacedByRunId: null, ...overrides };
  }

  /** A draft "Check again" replaced with run 9. */
  const replacedDraft = earlier('cancelled', { replacedByRunId: 9 });

  /** The run that replaced it: by default one that never got its preview. */
  function successor(status: PublishRunStatus, overrides: Partial<ReplacementRun> = {}): ReplacementRun {
    return { status, heartbeatAt: FRESH, preparedAt: null, ...overrides };
  }

  it('cancels a draft it copies ("Check again")', () => {
    expect(copyVerdict(earlier('draft'), undefined, NOW)).toEqual({
      ok: true,
      link: 'cancel',
      closesReplacement: false,
    });
  });

  it('leaves a finished run as it is ("Review the rest")', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(copyVerdict(earlier(status), undefined, NOW)).toEqual({
        ok: true,
        link: 'none',
        closesReplacement: false,
      });
    }
  });

  it('refuses a run that is still working, and takes a prepared one that stalled', () => {
    for (const status of ['preparing', 'queued', 'running'] as const) {
      expect(copyVerdict(earlier(status), undefined, NOW)).toEqual({
        ok: false,
        code: 'CONFLICT',
        detail: 'That run is still working.',
      });
    }
    expect(copyVerdict(earlier('running', { heartbeatAt: OLD }), undefined, NOW)).toMatchObject({
      ok: true,
      link: 'none',
    });
    expect(copyVerdict(earlier('queued', { heartbeatAt: OLD }), undefined, NOW)).toMatchObject({
      ok: true,
      link: 'none',
    });
  });

  it('refuses a run whose preview was never finished: its rows are partial', () => {
    const refusal = { ok: false, code: 'CONFLICT', detail: NOT_FINISHED } as const;
    expect(copyVerdict(earlier('failed', { preparedAt: null }), undefined, NOW)).toEqual(refusal);
    expect(copyVerdict(earlier('cancelled', { preparedAt: null }), undefined, NOW)).toEqual(refusal);
    expect(copyVerdict(earlier('preparing', { preparedAt: null, heartbeatAt: OLD }), undefined, NOW)).toEqual(refusal);
  });

  it('copies a replaced draft again when its replacement died before its preview was ready, and moves the link', () => {
    const moved = { ok: true, link: 'repoint', closesReplacement: false } as const;
    expect(copyVerdict(replacedDraft, successor('failed'), NOW)).toEqual(moved);
    expect(copyVerdict(replacedDraft, successor('cancelled'), NOW)).toEqual(moved);
    expect(copyVerdict(replacedDraft, undefined, NOW)).toEqual(moved);
  });

  it('closes a replacement that stalled while it was prepared, so its worker cannot finish a second draft', () => {
    expect(copyVerdict(replacedDraft, successor('preparing', { heartbeatAt: OLD }), NOW)).toEqual({
      ok: true,
      link: 'repoint',
      closesReplacement: true,
    });
  });

  it('refuses a replaced draft while the replacement is alive', () => {
    expect(copyVerdict(replacedDraft, successor('preparing'), NOW)).toEqual({
      ok: false,
      code: 'CONFLICT',
      detail: REPLACED,
    });
  });

  it('refuses a replaced draft once the replacement was prepared, whatever became of it', () => {
    for (const status of ['draft', 'queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
      for (const heartbeatAt of [FRESH, OLD]) {
        expect(copyVerdict(replacedDraft, successor(status, { preparedAt: PREPARED, heartbeatAt }), NOW)).toEqual({
          ok: false,
          code: 'CONFLICT',
          detail: REPLACED,
        });
      }
    }
  });

  it('refuses a replacement in a state no dead preview can be in', () => {
    for (const status of ['draft', 'queued', 'running', 'succeeded'] as const) {
      expect(copyVerdict(replacedDraft, successor(status, { heartbeatAt: OLD }), NOW)).toMatchObject({ ok: false });
    }
  });
});

describe('applyVerdict', () => {
  it('applies a draft for the first time', () => {
    expect(applyVerdict(run('draft'), NOW)).toEqual({ ok: true, resume: false });
  });

  it('resumes a run that failed, and a queued or running run that stalled, when the draft was prepared', () => {
    expect(applyVerdict(run('failed'), NOW)).toEqual({ ok: true, resume: true });
    expect(applyVerdict(run('queued', { heartbeatAt: OLD }), NOW)).toEqual({ ok: true, resume: true });
    expect(applyVerdict(run('running', { heartbeatAt: OLD }), NOW)).toEqual({ ok: true, resume: true });
  });

  it('refuses a run that is being published', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(applyVerdict(run(status), NOW)).toEqual({
        ok: false,
        code: 'JOB_ALREADY_RUNNING',
        detail: 'This run is already being published.',
      });
    }
  });

  it('refuses a run whose switch is alive, but not one whose switch stalled', () => {
    expect(applyVerdict(run('failed', switchOf('running', FRESH)), NOW)).toEqual({
      ok: false,
      code: 'JOB_ALREADY_RUNNING',
      detail: 'This run is being switched.',
    });
    expect(applyVerdict(run('failed', switchOf('queued', FRESH)), NOW)).toMatchObject({ ok: false });
    expect(applyVerdict(run('failed', switchOf('running', OLD)), NOW)).toEqual({ ok: true, resume: true });
  });

  it('refuses a preview that is being prepared, and one whose worker stopped', () => {
    expect(applyVerdict(run('preparing', { preparedAt: null }), NOW)).toEqual({
      ok: false,
      code: 'CONFLICT',
      detail: 'The preview is still being prepared.',
    });
    expect(applyVerdict(run('preparing', { preparedAt: null, heartbeatAt: OLD }), NOW)).toEqual({
      ok: false,
      code: 'CONFLICT',
      detail: 'The preview was not finished. Start a new one.',
    });
  });

  it('never applies a draft that was not prepared: a failed run, or a stalled queued one, without prepared_at', () => {
    const notFinished = {
      ok: false,
      code: 'CONFLICT',
      detail: 'The preview was not finished. Start a new one.',
    } as const;
    expect(applyVerdict(run('failed', { preparedAt: null }), NOW)).toEqual(notFinished);
    expect(applyVerdict(run('queued', { preparedAt: null, heartbeatAt: OLD }), NOW)).toEqual(notFinished);
  });

  it('refuses a finished run', () => {
    for (const status of ['succeeded', 'cancelled'] as const) {
      expect(applyVerdict(run(status), NOW)).toEqual({
        ok: false,
        code: 'CONFLICT',
        detail: 'This run is finished. Start a new one.',
      });
    }
  });
});

describe('cancelVerdict', () => {
  it('lets a preview be discarded without the publish permission', () => {
    expect(cancelVerdict({ status: 'preparing' })).toEqual({ ok: true, needsPublishPermission: false });
    expect(cancelVerdict({ status: 'draft' })).toEqual({ ok: true, needsPublishPermission: false });
  });

  it('needs the publish permission to stop a run that is queued or running (stalled or not: the stored status decides)', () => {
    expect(cancelVerdict({ status: 'queued' })).toEqual({ ok: true, needsPublishPermission: true });
    expect(cancelVerdict({ status: 'running' })).toEqual({ ok: true, needsPublishPermission: true });
  });

  it('refuses a run that is over', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(cancelVerdict({ status })).toMatchObject({ ok: false, code: 'CONFLICT' });
    }
  });
});

describe('switchVerdict', () => {
  it('switches a finished run that published something', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(switchVerdict(run(status), 3, NOW)).toEqual({ ok: true, closesStalledRun: false });
    }
  });

  it('allows a switch again after one that is done, failed or stalled', () => {
    expect(switchVerdict(run('succeeded', switchOf('done', FRESH)), 3, NOW)).toMatchObject({ ok: true });
    expect(switchVerdict(run('succeeded', switchOf('failed', FRESH)), 3, NOW)).toMatchObject({ ok: true });
    expect(switchVerdict(run('succeeded', switchOf('running', OLD)), 3, NOW)).toMatchObject({ ok: true });
  });

  it('refuses a switch that is alive', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(switchVerdict(run('succeeded', switchOf(status, FRESH)), 3, NOW)).toEqual({
        ok: false,
        code: 'JOB_ALREADY_RUNNING',
        detail: 'This run is being switched.',
      });
    }
  });

  it('closes a queued or running run that stalled first, and refuses one that is alive', () => {
    expect(switchVerdict(run('running', { heartbeatAt: OLD }), 3, NOW)).toEqual({ ok: true, closesStalledRun: true });
    expect(switchVerdict(run('queued', { heartbeatAt: OLD }), 3, NOW)).toEqual({ ok: true, closesStalledRun: true });
    expect(switchVerdict(run('running'), 3, NOW)).toEqual({
      ok: false,
      code: 'CONFLICT',
      detail: 'Only a finished run can be switched.',
    });
  });

  it('refuses a preview, stalled or not, and a draft', () => {
    for (const status of ['preparing', 'draft'] as const) {
      expect(switchVerdict(run(status, { heartbeatAt: OLD }), 3, NOW)).toMatchObject({
        ok: false,
        detail: 'Only a finished run can be switched.',
      });
    }
  });

  it('refuses a run that published nothing', () => {
    expect(switchVerdict(run('succeeded'), 0, NOW)).toEqual({
      ok: false,
      code: 'CONFLICT',
      detail: 'This run published nothing.',
    });
  });
});
