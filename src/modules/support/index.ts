// Public API of the support module: the statuses and the reply targets other modules read (the late-ticket rule of the dashboard uses
// the same numbers), the notification events, then the modules. Other modules import only this file.
export { PRIORITY_TARGET_MS, defaultPriority, slaDueAt } from './domain/ticket-sla';
export type { LastPublicMessage } from './domain/ticket-sla';
export { WIRE_TICKET_STATUSES, toWireStatus } from './domain/ticket-status';
export type { WireTicketStatus } from './domain/ticket-status';
export {
  SUPPORT_CSAT_SURVEY_EVENT,
  SUPPORT_EVENTS,
  SUPPORT_REPLY_EVENT,
  SUPPORT_TICKET_RECEIVED_EVENT,
} from './application/support-events';
export { SUPPORT_DEFAULT_TEMPLATES, supportTemplatesSql } from './application/support-templates';
export { SupportEventsModule } from './support-events.module';
export { TICKET_MAIL_EVENT } from './application/ticket-mail-outbox';
export { TicketMailJobs } from './application/ticket-mail.jobs';
export type { TicketMailJobResult } from './application/ticket-mail.jobs';
export { TicketMailProcessor } from './jobs/ticket-mail.processor';
export { SupportMailModule } from './support-mail.module';
export { SupportAdminModule } from './support-admin.module';
export { SupportErasureModule } from './support-erasure.module';
export { SupportStoreModule } from './support-store.module';
export { SupportModule } from './support.module';
