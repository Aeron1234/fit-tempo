import { activityWriteSchema, measurementWriteSchema, weightWriteSchema } from '@fit-tempo/contracts';
import { canonicalMealDecimal, resolveMealInstant } from './meal-form';

export type TrackingKind = 'activity' | 'weight' | 'measurements';

export function parseTrackingForm(kind: TrackingKind, form: FormData, zone: string, linkedStart?: string) {
  const linked = kind === 'activity' ? String(form.get('workout') ?? '') : '';
  const instant = linked ? linkedStart : resolveMealInstant(String(form.get('date')), zone);
  if (!instant) return { success: false as const, message: 'Choose a valid, unambiguous local date and time.' };
  const decimal = (name: string) => canonicalMealDecimal(String(form.get(name) ?? ''));
  const seconds = String(form.get('seconds') ?? '');
  const parsed = kind === 'activity' ? activityWriteSchema.safeParse({
    type: form.get('type'), occurredAt: instant,
    durationSeconds: !linked && seconds ? Number(seconds) : null, distanceMeters: linked ? null : decimal('meters') || null,
    ...(linked ? { linkedWorkoutId: linked } : {}),
  }) : kind === 'weight' ? weightWriteSchema.safeParse({
    measuredAt: instant, weightKg: decimal('kg'), note: String(form.get('note') ?? '').trim() || null,
  }) : measurementWriteSchema.safeParse({
    measuredAt: instant, measurementType: form.get('type'), valueCm: decimal('cm'),
  });
  return parsed.success ? parsed : {
    success: false as const, message: parsed.error.issues[0]?.message ?? 'Check the date, units, and value.',
  };
}
