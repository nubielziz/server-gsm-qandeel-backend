// The `storage` health indicator (decision 015): a HEAD on the bucket, non-critical for the API.
import type { HealthIndicator } from '../health';
import type { StorageService } from './storage.service';

/**
 * Health indicator for object storage.
 *
 * Why: the System health page shows the storage state (map "service health check: ... storage", B11). Uploads and
 * downloads fail while it is down, but the rest of the API works, so it is non-critical (`degraded`, not `down`).
 *
 * @see docs/decisions/015-observability.md
 */
export class StorageHealthIndicator implements HealthIndicator {
  readonly name = 'storage';
  readonly critical = false;

  constructor(private readonly storage: Pick<StorageService, 'ping'>) {}

  /**
   * Checks the bucket.
   *
   * @throws {Error} when the bucket cannot be reached; `HealthService` turns it into `down` and logs the reason
   */
  async check(): Promise<void> {
    await this.storage.ping();
  }
}
