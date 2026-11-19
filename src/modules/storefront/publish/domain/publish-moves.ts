// The state rules of the moves staff make on a publish run (feature 31, plan 31 section 5.2): when an earlier run can be copied into a new
// draft, when apply is allowed and whether it resumes, when a run can be cancelled, and when its switch can be asked. Pure: no database, no
// clock; the callers pass the run's row.
import type { ListingPublishRun } from '../../db/schema';
import { isStalled, isSwitchStalled } from './publish-item';

/** The refusal of a move: a `409` with its code and the sentence staff read. */
export interface MoveRefusal {
  readonly ok: false;
  readonly code: 'CONFLICT' | 'JOB_ALREADY_RUNNING';
  readonly detail: string;
}

/** The sentence of a run that is being published. */
export const BEING_PUBLISHED = 'This run is already being published.';

/** The sentence of a run that is being switched. */
export const BEING_SWITCHED = 'This run is being switched.';

/** The sentence of a preview that was not finished. */
export const PREVIEW_NOT_FINISHED = 'The preview was not finished. Start a new one.';

/** What a move reads of a run's row. */
export type MovedRun = Pick<ListingPublishRun, 'status' | 'heartbeatAt' | 'preparedAt' | 'switchStatus'>;

/** What the scope `run` reads of the run it copies. */
export type CopiedRun = Pick<ListingPublishRun, 'status' | 'heartbeatAt' | 'preparedAt' | 'replacedByRunId'>;

/** What the scope `run` reads of the run that replaced the one it copies. */
export type ReplacementRun = Pick<ListingPublishRun, 'status' | 'heartbeatAt' | 'preparedAt'>;

/** A copy that is allowed, and what it does to the runs around it. */
export interface CopyAllowed {
  readonly ok: true;
  /**
   * What happens to the run that is copied: `cancel` ("Check again" replaces a draft), `repoint` (it was replaced by a run that died before
   * its preview was ready, and now links to the new run) or `none` ("Review the rest": it stays as it is).
   */
  readonly link: 'none' | 'cancel' | 'repoint';
  /** The dead replacement is still stored `preparing`: it is closed, so a worker that wakes up cannot finish a second draft of these rows. */
  readonly closesReplacement: boolean;
}

const refuse = (code: MoveRefusal['code'], detail: string): MoveRefusal => ({ ok: false, code, detail });

/** Whether a run switch is alive: asked, and not stalled. */
function switchIsLive(run: MovedRun, nowMs: number): boolean {
  return (run.switchStatus === 'queued' || run.switchStatus === 'running') && !isSwitchStalled(run, nowMs);
}

/**
 * Judges the scope `run` of `POST /admin/publish-runs` against the earlier run and the run that replaced it, under their locks.
 *
 * Why: plan 31 sections 5.2 and 7.2. A run still at work is refused. A run whose preview was never finished holds partial rows, so it is
 * never copied. A draft is replaced ("Check again"), and a finished run gives the rows it did not publish ("Review the rest"). A draft that
 * was replaced already keeps one live successor: it is refused while the replacement is alive or once that was prepared, because the edits
 * live on there. When the replacement died before its preview was ready, nothing holds the edits but the old draft, so "Prepare again" (the
 * same scope, sent again) copies it once more and the link moves to the new run.
 *
 * @param old the earlier run
 * @param replacement the run its `replaced_by_run_id` names, or `undefined` when it has none (or that row is gone)
 * @param nowMs the clock's time in epoch milliseconds
 * @returns what the copy does ({@link CopyAllowed}), or the refusal (`CONFLICT`)
 */
export function copyVerdict(
  old: CopiedRun,
  replacement: ReplacementRun | undefined,
  nowMs: number,
): CopyAllowed | MoveRefusal {
  const working = old.status === 'preparing' || old.status === 'queued' || old.status === 'running';
  if (working && !isStalled(old, nowMs)) return refuse('CONFLICT', 'That run is still working.');
  if (old.preparedAt === null) return refuse('CONFLICT', PREVIEW_NOT_FINISHED);
  if (old.status === 'draft') return { ok: true, link: 'cancel', closesReplacement: false };
  if (old.replacedByRunId === null) return { ok: true, link: 'none', closesReplacement: false };
  if (replacement === undefined) return { ok: true, link: 'repoint', closesReplacement: false };

  // Only a run that never got its preview is dead for this purpose: every other state means the edits were copied, or are being copied.
  const stalledWhilePreparing = replacement.status === 'preparing' && isStalled(replacement, nowMs);
  const closedUnprepared = replacement.status === 'failed' || replacement.status === 'cancelled';
  if (replacement.preparedAt !== null || !(stalledWhilePreparing || closedUnprepared)) {
    return refuse('CONFLICT', 'That preview was already replaced by a newer one.');
  }
  return { ok: true, link: 'repoint', closesReplacement: stalledWhilePreparing };
}

/**
 * Judges `POST /admin/publish-runs/:id/apply` against the run under its lock.
 *
 * Why: plan 31 section 5.2 (the table of apply). A `draft` is applied (`first`); a run that `failed`, or that was `queued` or `running`
 * and stalled, continues with what is left (`resume`: only when its draft was prepared, so a half-evaluated draft is never applied); a
 * run that is alive, or whose switch is alive, is refused (the claim of the worker and of the switch share one counter); a finished run
 * is refused. A resume may find a switch that stalled: the caller closes it, because the heartbeat the resume writes is the one the switch
 * reads too.
 *
 * @param run the run's status, heartbeat, `prepared_at` and switch status
 * @param nowMs the clock's time in epoch milliseconds
 * @returns `{ ok: true, resume }` or the refusal (`CONFLICT`, `JOB_ALREADY_RUNNING`)
 */
export function applyVerdict(
  run: MovedRun,
  nowMs: number,
): { readonly ok: true; readonly resume: boolean } | MoveRefusal {
  switch (run.status) {
    case 'succeeded':
    case 'cancelled':
      return refuse('CONFLICT', 'This run is finished. Start a new one.');
    case 'preparing':
      return refuse('CONFLICT', isStalled(run, nowMs) ? PREVIEW_NOT_FINISHED : 'The preview is still being prepared.');
    case 'draft':
      return { ok: true, resume: false };
    case 'queued':
    case 'running':
      if (!isStalled(run, nowMs)) return refuse('JOB_ALREADY_RUNNING', BEING_PUBLISHED);
      return run.preparedAt === null ? refuse('CONFLICT', PREVIEW_NOT_FINISHED) : { ok: true, resume: true };
    case 'failed':
      if (run.preparedAt === null) return refuse('CONFLICT', PREVIEW_NOT_FINISHED);
      if (switchIsLive(run, nowMs)) return refuse('JOB_ALREADY_RUNNING', BEING_SWITCHED);
      return { ok: true, resume: true };
  }
}

/**
 * Judges `POST /admin/publish-runs/:id/cancel` against the run under its lock.
 *
 * Why: plan 31 section 5.2: a run can be cancelled while it is `preparing`, `draft`, `queued` or `running` (by its stored status: a
 * run that stalled can still be stopped, and the worker that wakes up later finds it cancelled). Stopping a run that is publishing is a
 * publishing decision, so it needs `storefront:publish`, which the caller checks with `needsPublishPermission`.
 *
 * @param run the run's status
 * @returns `{ ok: true, needsPublishPermission }` or the refusal (`CONFLICT`)
 */
export function cancelVerdict(
  run: Pick<ListingPublishRun, 'status'>,
): { readonly ok: true; readonly needsPublishPermission: boolean } | MoveRefusal {
  switch (run.status) {
    case 'preparing':
    case 'draft':
      return { ok: true, needsPublishPermission: false };
    case 'queued':
    case 'running':
      return { ok: true, needsPublishPermission: true };
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return refuse('CONFLICT', 'Only a preview or a run in progress can be cancelled.');
  }
}

/**
 * Judges `POST /admin/publish-runs/:id/listed` against the run under its lock.
 *
 * Why: plan 31 section 5.2: only a finished run (`succeeded`, `failed`, `cancelled`) can be switched, and only when it published a
 * listing; a switch that is alive is refused; a `queued` or `running` run that stalled is closed `failed` first (`closesStalledRun`),
 * as Quick add closes a stalled run at a restart.
 *
 * @param run the run's status, heartbeat and switch status
 * @param published how many rows of the run have the result `published`
 * @param nowMs the clock's time in epoch milliseconds
 * @returns `{ ok: true, closesStalledRun }` or the refusal (`CONFLICT`, `JOB_ALREADY_RUNNING`)
 */
export function switchVerdict(
  run: MovedRun,
  published: number,
  nowMs: number,
): { readonly ok: true; readonly closesStalledRun: boolean } | MoveRefusal {
  const live = run.status === 'queued' || run.status === 'running';
  if (run.status === 'preparing' || run.status === 'draft' || (live && !isStalled(run, nowMs))) {
    return refuse('CONFLICT', 'Only a finished run can be switched.');
  }
  if (switchIsLive(run, nowMs)) return refuse('JOB_ALREADY_RUNNING', BEING_SWITCHED);
  if (published === 0) return refuse('CONFLICT', 'This run published nothing.');
  return { ok: true, closesStalledRun: live };
}
