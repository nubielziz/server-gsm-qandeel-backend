// Unit tests of the file kinds (decision 047): the read permission each kind of record adds to a staff download.
import { describe, expect, it } from 'bun:test';
import {
  AUDITED_FILE_KINDS,
  FILE_KINDS,
  FILE_KIND_PERMISSIONS,
  type FileReferences,
  auditedKindsOf,
  fileKindsOf,
  permissionsForFile,
} from '@src/modules/platform/files/file-kinds';

const NOTHING: FileReferences = {
  disputeEvidence: false,
  orderFile: false,
  invoiceDocument: false,
  ticketAttachment: false,
  dataExport: false,
};

describe('permissionsForFile', () => {
  it('names the read permission of each kind, in order, each once', () => {
    expect(permissionsForFile(['data_export', 'identity_document', 'identity_document'])).toEqual([
      'clients:read',
      'customers:privacy',
    ]);
    expect(permissionsForFile([...FILE_KINDS].reverse())).toEqual(
      FILE_KINDS.map((kind) => FILE_KIND_PERMISSIONS[kind]),
    );
    expect(FILE_KIND_PERMISSIONS).toEqual({
      identity_document: 'clients:read',
      payment_proof: 'payments:read',
      dispute_evidence: 'disputes:read',
      order_file: 'orders:read',
      invoice_document: 'invoices:read',
      ticket_attachment: 'support:read',
      data_export: 'customers:privacy',
    });
  });

  it('finds no extra permission for a file nothing uses', () => {
    expect(permissionsForFile([])).toEqual([]);
  });

  it('audits the downloads of identity documents and payment proofs only', () => {
    expect(AUDITED_FILE_KINDS).toEqual(['identity_document', 'payment_proof']);
  });
});

describe('auditedKindsOf', () => {
  it('keeps the audited kinds of a file, in order, each once, and none for the other kinds', () => {
    expect(auditedKindsOf([])).toEqual([]);
    expect(auditedKindsOf(['order_file', 'ticket_attachment', 'data_export'])).toEqual([]);
    expect(auditedKindsOf(['ticket_attachment', 'payment_proof', 'identity_document', 'payment_proof'])).toEqual([
      'identity_document',
      'payment_proof',
    ]);
    // The rule is the list: every kind of FILE_KINDS is audited exactly when AUDITED_FILE_KINDS names it.
    for (const kind of FILE_KINDS) {
      expect(auditedKindsOf([kind]).length === 1, kind).toBe(AUDITED_FILE_KINDS.includes(kind));
    }
  });
});

describe('fileKindsOf', () => {
  it('reads the kinds of a reference row, in the order of the list', () => {
    expect(fileKindsOf(NOTHING)).toEqual([]);
    expect(
      fileKindsOf({
        ...NOTHING,
        identityDocument: { submissionId: 4, clientId: 2, clientName: 'Zain' },
        paymentId: 9,
        orderFile: true,
        dataExport: true,
      }),
    ).toEqual(['identity_document', 'payment_proof', 'order_file', 'data_export']);
    expect(fileKindsOf({ ...NOTHING, ticketAttachment: true, invoiceDocument: true, disputeEvidence: true })).toEqual([
      'dispute_evidence',
      'invoice_document',
      'ticket_attachment',
    ]);
  });
});
