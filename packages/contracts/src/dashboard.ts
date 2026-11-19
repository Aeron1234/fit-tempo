import { z } from 'zod';
import { decimalSchema } from './common.js';
import { localDateSchema, timeZoneSchema } from './time.js';

const item = z.strictObject({ calories: decimalSchema.nullable(), protein: decimalSchema.nullable() });
const day = z.strictObject({
  date: localDateSchema,
  timezone: timeZoneSchema,
  status: z.enum(['unrecorded', 'partial', 'complete']),
  items: z.array(item),
  hasEntries: z.boolean().optional(),
});
type Day = z.input<typeof day>;
const scale = 1_000_000n;

function subtotal(values: (string | null)[], confirmedZero: boolean) {
  let sum = 0n;
  let missingItemCount = 0;
  for (const value of values) {
    if (value === null) {
      missingItemCount++;
      continue;
    }
    const [whole, fraction = ''] = value.split('.');
    sum += BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0'));
  }
  const fraction = (sum % scale).toString().padStart(6, '0').replace(/0+$/, '');
  const knownSubtotal = values.length > missingItemCount || confirmedZero
    ? `${sum / scale}${fraction ? '.' + fraction : ''}`
    : null;
  return { knownSubtotal, missingItemCount };
}

export function aggregateDay(input: Day) {
  const { date, timezone, status, items, hasEntries } = day.parse(input);
  const recorded = items.length > 0 || hasEntries === true;
  const confirmedZero = status === 'complete' && !recorded;
  return {
    date, timezone,
    status: status === 'complete' ? status : recorded ? 'partial' as const : 'unrecorded' as const,
    itemCount: items.length,
    calories: { unit: 'kcal' as const, ...subtotal(items.map(value => value.calories), confirmedZero) },
    protein: { unit: 'g' as const, ...subtotal(items.map(value => value.protein), confirmedZero) },
  };
}

export const syntheticDashboardDates = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'] as const;
export const dashboardFixtures: Readonly<Record<string, Day | undefined>> = Object.freeze({
  '2026-11-15': { date: '2026-11-15', timezone: 'Asia/Manila', status: 'unrecorded', items: [] },
  '2026-11-16': { date: '2026-11-16', timezone: 'Asia/Manila', status: 'partial',
    items: [{ calories: '150', protein: '8.1' }] },
  '2026-11-17': { date: '2026-11-17', timezone: 'Asia/Manila', status: 'complete', items: [] },
  '2026-11-18': { date: '2026-11-18', timezone: 'Asia/Manila', status: 'complete',
    items: [{ calories: '225', protein: '14.2' }, { calories: '175', protein: null }] },
} satisfies Record<string, Day>);
