// Seam for surface-specific error envelopes (decision 026): problem+json by default, Dhru registers its own later.
// The exception filter asks the registry for a formatter; the first registered formatter that matches the request wins.
import { Injectable } from '@nestjs/common';
import type { Surface } from '../surface';
import type { AppError } from './app-error';
import type { ProblemDocument } from './problem';

/**
 * What the filter sends: status, media type, optional extra headers and the body object.
 *
 * Why: the Dhru surface keeps its own envelope (decision 026), so the filter sends whatever a formatter built, not
 * always problem+json.
 */
export interface ErrorResponse {
  readonly status: number;
  readonly contentType: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Everything a formatter may use to build the response.
 *
 * Why: a formatter must build the right body for its surface from the error alone, without reading the request itself.
 */
export interface ErrorFormatContext {
  readonly error: AppError;
  /** The default problem+json document of this error. */
  readonly problem: ProblemDocument;
  readonly requestId: string;
  readonly path: string;
  readonly surface: Surface;
}

/**
 * Builds the error response of one surface.
 *
 * Why: decision 028 gives every surface problem+json except Dhru; one formatter per surface keeps that rule in one
 * place.
 */
export interface ErrorFormatter {
  /** Unique name, shown in boot errors. */
  readonly name: string;
  /** True when this formatter owns the request (e.g. `path` is `/api/index.php`). */
  matches(request: { readonly path: string; readonly surface: Surface }): boolean;
  /** Returns the response for the error. */
  format(context: ErrorFormatContext): ErrorResponse;
}

/**
 * Holds the surface-specific formatters.
 *
 * Why: the Dhru surface must answer HTTP 200 with its own SUCCESS/ERROR envelope, never problem+json (decision 026);
 * its module registers a formatter in `onModuleInit` without touching the filter.
 */
@Injectable()
export class ErrorFormatterRegistry {
  private readonly formatters: ErrorFormatter[] = [];

  /**
   * Adds a formatter.
   *
   * @param formatter the surface formatter
   * @throws {Error} when a formatter with the same name exists (a boot-time programming error)
   */
  register(formatter: ErrorFormatter): void {
    if (this.formatters.some((existing) => existing.name === formatter.name)) {
      throw new Error(`Error formatter "${formatter.name}" is already registered`);
    }
    this.formatters.push(formatter);
  }

  /**
   * Finds the formatter for a request.
   *
   * @param request the request path and surface
   * @returns the first matching formatter, or `undefined` for the default problem+json
   */
  resolve(request: { readonly path: string; readonly surface: Surface }): ErrorFormatter | undefined {
    return this.formatters.find((formatter) => formatter.matches(request));
  }
}
