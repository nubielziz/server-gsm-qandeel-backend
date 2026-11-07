// Nest module of the PDF renderer (decision 030). Global and dependency-free, so any module (billing now, reports later) injects it.
import { Global, Module } from '@nestjs/common';
import { PdfRenderer } from './pdf-renderer';

/**
 * Provides {@link PdfRenderer} to the whole app.
 *
 * Why: the invoice documents (feature 8) and the client statement (feature 11) share one renderer. It needs no database, Redis or
 * storage, so a test app built without them still builds.
 */
@Global()
@Module({ providers: [PdfRenderer], exports: [PdfRenderer] })
export class PdfModule {}
