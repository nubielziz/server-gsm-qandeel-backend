// Feature 27 (real-time layer, live notifications): the routes beyond the map (decisions 035 and 037, plan
// docs/briefs/27-realtime-notifications.md § 6): one server-sent event stream per signed-in surface.
import { R } from '../lib/map-additions.mjs';

const STREAMS = 'B216';
const TABLES = ['sessions', 'notification_inbox', 'notification_campaigns'];

export const rows = [
  R('admin', 'ops', 'GET', '/admin/stream', 'قناة الأحداث الحية للموظف (SSE)', 'جلسة', 27, TABLES, {
    en: "The staff member's live event stream (server-sent events).",
    module: 'identity',
    spec: STREAMS,
    successStatus: 200,
  }),
  R('client', 'growth', 'GET', '/client/stream', 'قناة الأحداث الحية للتاجر (SSE)', 'جلسة', 27, TABLES, {
    en: "The merchant's live event stream (server-sent events).",
    module: 'identity',
    spec: STREAMS,
    successStatus: 200,
  }),
  R('store', 'account', 'GET', '/store/v1/me/stream', 'قناة الأحداث الحية للزبون (SSE)', 'جلسة الزبون', 27, TABLES, {
    en: "The customer's live event stream (server-sent events).",
    module: 'identity',
    spec: STREAMS,
    successStatus: 200,
  }),
];
