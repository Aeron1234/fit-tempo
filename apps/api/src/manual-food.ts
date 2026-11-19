import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { manualFoodSchema } from '@fit-tempo/contracts';

const units = {
  energyKcal: 'kcal', proteinG: 'g', carbsG: 'g', fatG: 'g', fiberG: 'g', sodiumMg: 'mg',
} as const;

export function createManualFoodRouter(db: Pool) {
  const router = Router();
  router.post('/', async (req, res) => {
    const parsed = manualFoodSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Provide a valid food name, basis and nutrients.', requestId: res.locals.requestId },
    });
    const food = parsed.data;
    const id = randomUUID();
    const nutrientRows = (Object.keys(units) as (keyof typeof units)[]).map(code => ({
      code, unit: units[code], amount: food.nutrients[code],
    }));
    await db.query(`
      WITH created AS (
        INSERT INTO foods (id, owner_id, visibility, source_kind, source_record_id, name,
          preparation, basis, basis_grams)
        VALUES ($1::uuid, $2, 'private', 'user', $1::uuid::text, $3, $4, $5, $6)
        RETURNING id
      )
      INSERT INTO food_nutrients (food_id, nutrient_code, amount, unit)
      SELECT created.id, input.code, input.amount, input.unit FROM created
      CROSS JOIN jsonb_to_recordset($7::jsonb) AS input(code text, amount numeric, unit text)
    `, [id, res.locals.userId, food.name, food.preparation === 'unknown' ? 'unspecified' : food.preparation,
      food.basis.kind === 'per_100g' ? 'per100g' : 'perServing', food.basis.grams, JSON.stringify(nutrientRows)]);
    return res.status(201).json({ data: { id } });
  });
  return router;
}
