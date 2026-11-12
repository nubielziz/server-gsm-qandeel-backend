// Routes of feature 26 (supplier quick add) that the API design map does not have (decision 035): the supplier's service groups with
// counts, the start of a quick add by group or for all services (it runs in the background), and the state of a run.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'admin',
    'suppliers',
    'GET',
    '/admin/suppliers/:id/service-groups',
    'مجموعات خدمات المورد مع الأعداد وآخر إضافة سريعة',
    'suppliers:read',
    26,
    ['supplier_services', 'service_supplier_links', 'supplier_import_runs'],
    {
      en: "The supplier's service groups with counts and the latest quick add.",
      module: 'suppliers',
      spec: 'B-TBD supplier-quick-add',
      successStatus: 200,
    },
  ),
  R(
    'admin',
    'suppliers',
    'POST',
    '/admin/suppliers/:id/quick-add',
    'إضافة سريعة: إضافة خدمات المورد حسب المجموعة أو كلها في الخلفية',
    'catalog:create',
    26,
    ['supplier_import_runs', 'outbox_events', 'audit_logs'],
    {
      en: "Quick add: add the supplier's services by group, or all of them, in the background.",
      module: 'suppliers',
      spec: 'B-TBD supplier-quick-add',
      successStatus: 202,
    },
  ),
  R(
    'admin',
    'suppliers',
    'GET',
    '/admin/suppliers/:id/quick-add/:runId',
    'حالة الإضافة السريعة وتقدّمها',
    'suppliers:read',
    26,
    ['supplier_import_runs'],
    {
      en: 'The state and progress of a quick add.',
      module: 'suppliers',
      spec: 'B-TBD supplier-quick-add',
      successStatus: 200,
    },
  ),
];
