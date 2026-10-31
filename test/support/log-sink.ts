// In-memory log destination for integration tests: nestjs-pino keeps one root logger per process, so every test app
// writes into this single sink (passed through the LOG_DESTINATION token); tests clear it and filter by request id.
export type LogLine = Record<string, unknown> & { level: number; msg?: string; requestId?: string };

/** Collects pino JSON lines. */
export const logSink = {
  lines: [] as LogLine[],
  write(chunk: string): void {
    for (const text of chunk.split('\n')) {
      if (text.trim() !== '') this.lines.push(JSON.parse(text) as LogLine);
    }
  },
  clear(): void {
    this.lines.length = 0;
  },
  /** Lines written for one request id. */
  forRequest(requestId: string): LogLine[] {
    return this.lines.filter((line) => line.requestId === requestId);
  },
};
