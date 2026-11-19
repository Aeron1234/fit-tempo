import { z } from 'zod';

export const localDateSchema = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, { message: 'A real calendar date is required.' });

export const instantSchema = z.iso.datetime()
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'A UTC instant with at most millisecond precision is required.',
  });
export const timeZoneSchema = z.string().min(1).max(100)
  .regex(/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, { message: 'A supported IANA timezone is required.' });

export function localDateAt(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
}

export const recordedTimeSchema = z.strictObject({
  occurredAt: instantSchema,
  timeZone: timeZoneSchema,
  localDate: localDateSchema,
}).superRefine((value, context) => {
  if (!instantSchema.safeParse(value.occurredAt).success || !timeZoneSchema.safeParse(value.timeZone).success) return;
  if (localDateAt(value.occurredAt, value.timeZone) !== value.localDate) {
    context.addIssue({ code: 'custom', path: ['localDate'], message: 'Recorded local date must match the instant in its recorded timezone.' });
  }
}).readonly();

export type RecordedTime = z.infer<typeof recordedTimeSchema>;
