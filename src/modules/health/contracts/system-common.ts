// Zod shapes shared by the System health and Dashboard routes: measured values, series points, staff references and the closed
// word lists (the console's `types/common.ts`). Wire format: docs/contract/ALIGNMENT.md; semantics: docs/contract/endpoints/health.md.
import { z } from 'zod';
import { zId, zIsoDateTime } from '../../../common/contract';

/** The verdict words of a measured value. */
export const METRIC_STATES = ['ok', 'warn', 'crit', 'unknown'] as const;
/** The units of a measured value. */
export const MEASURE_UNITS = ['ms', 's', 'percent', 'per_min', 'count', 'bytes'] as const;

/** One measured number with the server's verdict and the limits it applied (the console's `Measure`). */
export const zMeasure = z.object({
  value: z.number().nullable(),
  unit: z.enum(MEASURE_UNITS),
  state: z.enum(METRIC_STATES),
  warn: z.number().optional(),
  crit: z.number().optional(),
  direction: z.enum(['above', 'below']).optional(),
});

/** One point of a time series, oldest first; a null value is a gap. */
export const zSeriesPoint = z.object({ at: zIsoDateTime, value: z.number().nullable() });

/** A staff member named on a record. */
export const zStaffRef = z.object({ id: zId, name: z.string() });

/** The status of a checked component. */
export const zCheckStatus = z.enum(['ok', 'degraded', 'down', 'unknown']);

/** The windows of the history charts (`?range=`). */
export const zRange = z.enum(['1h', '6h', '24h', '7d']);

/** The service types of an order. */
export const zServiceType = z.enum(['imei', 'server', 'remote', 'file']);
