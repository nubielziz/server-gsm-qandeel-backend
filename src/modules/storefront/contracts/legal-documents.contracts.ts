// Route contracts of the legal documents (map domain H, stage 15): versions of the terms, privacy, refund and cookie policies.
// Shapes match the console's LegalDocument (docs/contract/endpoints/storefront.md, RESOLUTIONS b2c-14, ANSWERS storefront Q5).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { LEGAL_DOCUMENT_TYPES, type LegalDocumentType } from '../db/schema';
import { LEGAL_VERSION_MAX_LENGTH, LEGAL_VERSION_PATTERN } from '../domain/legal';
import { BODY_MAX, LocaleField, STOREFRONT_LOCALES, requiredMarkdown } from './shared';

/** A version as the console reads it. */
const LegalRow = z.object({
  id: zId,
  type: z.string().describe('`terms`, `privacy`, `refund` or `cookies`.'),
  version: z.string().describe("Text such as `'3.2'`."),
  locale: z.string(),
  bodyMd: z.string(),
  effectiveFrom: zIsoDateTime.nullable().describe('`null` until published; kept after the version is replaced.'),
  isCurrent: z.boolean().describe('One per type and language.'),
  requiresReacceptance: z.boolean(),
  createdAt: zIsoDateTime,
  acceptedCount: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe('Granted consents that reference this version; `null` for a version that was never published.'),
});

const LEGAL_EXAMPLE = {
  id: 1,
  type: 'terms',
  version: '3.2',
  locale: 'en',
  bodyMd: '# Terms of service',
  effectiveFrom: '2026-10-01T09:00:00.000Z',
  isCurrent: true,
  requiresReacceptance: false,
  createdAt: '2026-09-25T09:00:00.000Z',
  acceptedCount: 125,
} as const;

/** `GET /admin/legal-documents`: every version. */
export const listLegalDocuments = defineRoute({
  key: 'GET /admin/legal-documents',
  summary: 'List legal document versions',
  description:
    'Every version of every document. The console groups them: current (`isCurrent`), draft (not current, `effectiveFrom` ' +
    'null) and earlier (not current, `effectiveFrom` set). Filters: `type`, `locale` and `isCurrent`. `q` is a contains over the ' +
    'type and the version. Default order: type.',
  tags: ['legal-documents'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'legal:read',
  query: listQuery({
    sorts: ['type', 'version', 'locale', 'effectiveFrom', 'createdAt', 'id'],
    defaultSort: { field: 'type', order: 'asc' },
    filters: {
      type: { type: 'enum', values: LEGAL_DOCUMENT_TYPES },
      locale: { type: 'enum', values: STOREFRONT_LOCALES },
      isCurrent: { type: 'boolean' },
    },
    search: ['type', 'version'],
  }),
  success: { status: 200, schema: LegalRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [LEGAL_EXAMPLE] },
});

/** `GET /admin/legal-documents/:id`: one version. */
export const showLegalDocument = defineRoute({
  key: 'GET /admin/legal-documents/:id',
  summary: 'Show a legal document version',
  tags: ['legal-documents'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'legal:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: LegalRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: LEGAL_EXAMPLE },
});

/** `POST /admin/legal-documents`: a new draft version. */
export const createLegalDocument = defineRoute({
  key: 'POST /admin/legal-documents',
  summary: 'Create a legal document version',
  description:
    'A draft: not current, `effectiveFrom` null. A version text is never edited afterwards (there is no edit route). The ' +
    'version text is 1 to 32 characters of letters, digits, dots, hyphens and underscores. A version that already exists for ' +
    'that type and language is `409 VERSION_EXISTS` on `version` (also when two requests race). `requiresReacceptance` defaults ' +
    'to true.',
  tags: ['legal-documents'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'legal:create',
  body: z.object({
    type: z
      .string()
      .trim()
      .refine((value): value is LegalDocumentType => (LEGAL_DOCUMENT_TYPES as readonly string[]).includes(value), {
        error: 'Choose a document: terms, privacy, refund or cookies.',
      })
      .meta({ description: '`terms`, `privacy`, `refund` or `cookies`.', examples: ['terms'] }),
    locale: LocaleField,
    version: z
      .string()
      .trim()
      .max(LEGAL_VERSION_MAX_LENGTH, `Use at most ${LEGAL_VERSION_MAX_LENGTH} characters.`)
      .regex(LEGAL_VERSION_PATTERN, 'Enter a version number such as 3.3 (letters, digits, dots and hyphens).'),
    bodyMd: requiredMarkdown(BODY_MAX, 'Enter the text of the document.'),
    requiresReacceptance: z.boolean().optional(),
  }),
  success: { status: 201, schema: LegalRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'VERSION_EXISTS'],
  examples: {
    request: { type: 'terms', locale: 'en', version: '3.3', bodyMd: '# Terms of service', requiresReacceptance: true },
    response: { ...LEGAL_EXAMPLE, version: '3.3', effectiveFrom: null, isCurrent: false, acceptedCount: null },
  },
});

/** `POST /admin/legal-documents/:id/publish`: put a draft version in force. */
export const publishLegalDocument = defineRoute({
  key: 'POST /admin/legal-documents/:id/publish',
  summary: 'Publish a legal document version',
  description:
    'In one transaction the version in force for the same type and language stops being current (its `effectiveFrom` is kept) ' +
    'and this one becomes current with `effectiveFrom` now. New consents reference it from then on; `requiresReacceptance` ' +
    'makes signed-in customers accept it again at their next checkout. Audited as `published legal document`. Only a draft ' +
    'can be published: the version already in force is `409 ALREADY_CURRENT`, a replaced one `409 NOT_A_DRAFT`.',
  tags: ['legal-documents'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'legal:publish',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: LegalRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ALREADY_CURRENT', 'NOT_A_DRAFT'],
  examples: { response: LEGAL_EXAMPLE },
});
