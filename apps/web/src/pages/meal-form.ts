import { instantSchema } from '@fit-tempo/contracts';

export function mealWallTime(instant: string, timeZone: string) {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = clock.formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export function resolveMealInstant(wallTime: string, timeZone: string) {
  const input = `${wallTime}:00.000Z`;
  if (!instantSchema.safeParse(input).success) return null;
  const wallMs = Date.parse(input);
  // Sample both sides of transitions so a duplicated wall time cannot silently select an offset.
  const candidates = new Set<string>();
  for (const shift of [-24, 0, 24]) {
    const sample = wallMs + shift * 3_600_000;
    const interpreted = Date.parse(`${mealWallTime(new Date(sample).toISOString(), timeZone)}:00.000Z`);
    const candidate = new Date(wallMs - (interpreted - sample)).toISOString();
    if (instantSchema.safeParse(candidate).success && mealWallTime(candidate, timeZone) === wallTime) {
      candidates.add(candidate);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function canonicalMealDecimal(value: string) {
  return value.trim().replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
