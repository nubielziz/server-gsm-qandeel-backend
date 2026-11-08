// Support module (map domain J): tickets, ticket messages and reply templates (docs/ARCHITECTURE.md § 2). Stage 17 built the storefront
// ticket routes, the staff inbox and the reply templates.
import { Module } from '@nestjs/common';
import { SupportAdminModule } from './support-admin.module';
import { SupportEventsModule } from './support-events.module';
import { SupportMailModule } from './support-mail.module';
import { SupportStoreModule } from './support-store.module';

/**
 * Nest module for Support (map domain J).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts` (decision 016). The routes
 * with their use cases (`SupportAdminModule`, `SupportStoreModule`) are separate so a test app built without a database can leave them
 * out; the notification events and the outbox route (`SupportEventsModule`) need neither and, with the sending job (`SupportMailModule`), are also
 * loaded by the worker.
 */
@Module({ imports: [SupportEventsModule, SupportMailModule, SupportAdminModule, SupportStoreModule] })
export class SupportModule {}
