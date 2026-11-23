import { z } from 'zod';

const targetAmounts = z.strictObject({
  energyKcal: z.number().int().min(1).max(20000),
  proteinG: z.number().int().min(0).max(5000),
  carbsG: z.number().int().min(0).max(5000),
  fatG: z.number().int().min(0).max(5000),
});
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const savedTargets = targetAmounts.extend({ effectiveFrom: z.iso.date(), savedAt: z.iso.datetime().optional() }).nullable();
export const nutritionTargetWriteSchema = targetAmounts.extend({ revision, clientOperationId: z.uuid() });
export const nutritionTargetsResponseSchema = z.object({
  data: z.object({
    revision,
    targets: savedTargets,
    dayTargets: savedTargets.optional(),
    localDate: z.iso.date().optional(),
    latestWeight: z.object({
      weightKg: z.string(),
      measuredAt: z.iso.datetime(),
      localDate: z.iso.date(),
    }).nullable().optional(),
  }),
});

const estimateInputs = z.object({
  age: z.number().int().min(19).max(78),
  heightCm: z.number().min(100).max(250),
  weightKg: z.number().min(30).max(300),
  equation: z.enum(['male', 'female']),
  activity: z.enum(['low', 'moderate', 'high']),
  goal: z.enum(['maintain', 'build', 'lose']),
});

export function estimateNutritionTargets(input: z.input<typeof estimateInputs>) {
  const parsed = estimateInputs.safeParse(input);
  if (!parsed.success) return null;
  const { age, heightCm, weightKg, equation, activity, goal } = parsed.data;
  const bmi = weightKg / (heightCm / 100) ** 2;
  if (bmi < 18.5 || (goal === 'lose' && bmi < 25)) return null;
  const resting = 10 * weightKg + 6.25 * heightCm - 5 * age + (equation === 'male' ? 5 : -161);
  const maintenance = resting * { low: 1.55, moderate: 1.85, high: 2.1 }[activity];
  const energyKcal = Math.round(maintenance * { maintain: 1, build: 1.05, lose: 0.9 }[goal]);
  if (energyKcal < 1400 || energyKcal > 6000) return null;
  return {
    maintenanceKcal: Math.round(maintenance),
    energyKcal,
    proteinG: Math.round(energyKcal * 0.25 / 4),
    carbsG: Math.round(energyKcal * 0.45 / 4),
    fatG: Math.round(energyKcal * 0.30 / 9),
  };
}
