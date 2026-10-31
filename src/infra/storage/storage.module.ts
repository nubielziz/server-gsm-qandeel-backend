// Global Nest module for object storage (decision 004): StorageService and the non-critical `storage` health check.
import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry, HealthRegistryModule } from '../health';
import { StorageHealthIndicator } from './storage.health';
import { StorageService } from './storage.service';

/**
 * Provides {@link StorageService} to every module and registers the storage health indicator.
 *
 * Why: file uploads, KYC documents, receipts and result files go through one S3 client per process (decision 004), and
 * `GET /health` reports the store (decision 015).
 */
@Global()
@Module({ imports: [HealthRegistryModule], providers: [StorageService], exports: [StorageService] })
export class StorageModule implements OnModuleInit {
  constructor(
    private readonly storage: StorageService,
    private readonly registry: HealthRegistry,
  ) {}

  /** Registers the `storage` indicator; the check itself runs only when `/health` is called. */
  onModuleInit(): void {
    this.registry.register(new StorageHealthIndicator(this.storage));
  }
}
