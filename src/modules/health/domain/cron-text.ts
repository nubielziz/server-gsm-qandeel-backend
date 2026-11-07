// The schedule of a job as the System health jobs list shows it: a cron pattern and the same in words. Pure.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A BullMQ scheduler's repeat rule: a cron `pattern` or a fixed `every` interval in milliseconds. */
export interface Repeat {
  readonly pattern?: string | null;
  readonly every?: number | null;
}

/**
 * The cron pattern of a repeat rule.
 *
 * Why: the console prints `schedule` in mono as a cron expression; an `every` rule that is a whole number of minutes, hours or
 * days has an exact cron form, any other interval is written as `every <n> s`.
 *
 * @param repeat the scheduler's rule
 * @returns the cron pattern (five fields) or `every <n> s`
 */
export function cronOf(repeat: Repeat): string {
  if (repeat.pattern) return repeat.pattern;
  const every = repeat.every ?? 0;
  if (every <= 0) return '';
  if (every % DAY_MS === 0 && every === DAY_MS) return '0 0 * * *';
  if (every % HOUR_MS === 0 && every < DAY_MS && 24 % (every / HOUR_MS) === 0) {
    return every === HOUR_MS ? '0 * * * *' : `0 */${every / HOUR_MS} * * *`;
  }
  if (every % MINUTE_MS === 0 && every < HOUR_MS && 60 % (every / MINUTE_MS) === 0) {
    return every === MINUTE_MS ? '* * * * *' : `*/${every / MINUTE_MS} * * * *`;
  }
  return `every ${Math.round(every / 1000)} s`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The schedule in words.
 *
 * Why: `scheduleText` is rendered by the server so the console needs no cron parser; it may be empty for a pattern this
 * function does not recognise (the console then shows only the cron).
 *
 * @param cron the pattern from {@link cronOf}
 * @returns for example `Every minute`, `Every 15 minutes`, `Daily at 03:15 UTC`, or `''`
 */
export function cronText(cron: string): string {
  const every = /^every (\d+) s$/.exec(cron);
  if (every) return `Every ${every[1]} seconds`;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return '';
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (dom !== '*' || month !== '*') return '';
  if (minute === '*' && hour === '*' && dow === '*') return 'Every minute';
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === '*' && dow === '*') return `Every ${step[1]} minutes`;
  if (/^\d+$/.test(minute) && hour === '*' && dow === '*')
    return minute === '0' ? 'Every hour' : `Every hour at minute ${minute}`;
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(minute) && hourStep && dow === '*') return `Every ${hourStep[1]} hours`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const at = `${pad(Number(hour))}:${pad(Number(minute))} UTC`;
    if (dow === '*') return `Daily at ${at}`;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return /^\d$/.test(dow) ? `Every ${days[Number(dow) % 7]} at ${at}` : '';
  }
  return '';
}

/**
 * A readable English name for a job from its stable key.
 *
 * Why: the jobs list needs a `label`; the key (`session_purge`) is the one stable name, so the label is the key in words.
 *
 * @param job the job name
 * @returns for example `Session purge`
 */
export function jobLabel(job: string): string {
  const words = job.replace(/[_-]+/g, ' ').trim();
  return words === '' ? job : words.charAt(0).toUpperCase() + words.slice(1);
}
