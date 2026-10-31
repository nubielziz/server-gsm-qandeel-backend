// Reads one sample from Prometheus exposition text, so a failing test prints a number, not the whole scrape.

/**
 * Finds the value of a metric line that has all the given label values.
 *
 * @param text exposition text from `/metrics`
 * @param name metric name including any `_count`/`_total` suffix
 * @param labels label values the line must carry
 * @returns the sample value, or 0 when no such line exists
 */
export function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  const line = text
    .split('\n')
    .find(
      (candidate) =>
        candidate.startsWith(`${name}{`) &&
        Object.entries(labels).every(([key, value]) => candidate.includes(`${key}="${value}"`)),
    );
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
}
