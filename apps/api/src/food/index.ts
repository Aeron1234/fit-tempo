import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { positiveDecimalSchema, sourceIdentitySchema, uuidSchema } from '@fit-tempo/contracts';
import { attribution, decimal, fixtures, readNutrients, type CatalogFood } from './model.js';
import { lookupBarcode, lookupUsda } from './providers.js';

export type { CatalogFood } from './model.js';

type FoodRow = {
  id: string;
  name: string;
  source_kind: CatalogFood['source']['source'];
  source_record_id: string;
  source_revision: string;
  revision: string;
  preparation: 'raw' | 'cooked' | 'unspecified';
  basis: 'per100g' | 'perServing';
  basis_grams: string | null;
  nutrients: Record<string, unknown>;
};

export async function loadCatalogFoods(db: Pool, userId: string,
  filter: { query: string } | { id: string }): Promise<CatalogFood[]> {
  const byId = 'id' in filter;
  const result = await db.query<FoodRow>(`
    SELECT f.id, f.name, f.source_kind, f.source_record_id, f.source_revision, f.revision,
      f.preparation, f.basis, f.basis_grams,
      COALESCE(jsonb_object_agg(n.nutrient_code, n.amount::text)
        FILTER (WHERE n.nutrient_code IS NOT NULL), '{}'::jsonb) AS nutrients
    FROM foods f
    LEFT JOIN food_nutrients n ON n.food_id = f.id
    WHERE ((f.owner_id = $1 AND f.visibility = 'private')
      OR (f.owner_id IS NULL AND f.visibility = 'approved'))
      AND ${byId ? 'f.id = $2' : 'strpos(lower(f.name), lower($2)) > 0'}
    GROUP BY f.id
    ORDER BY f.name, f.id
    LIMIT 12
  `, [userId, byId ? filter.id : filter.query]);
  return result.rows.map(row => {
    const source = sourceIdentitySchema.parse({
      source: row.source_kind, sourceRecordId: row.source_record_id, revision: Number(row.source_revision),
    });
    const grams = decimal(row.basis_grams);
    return {
      id: row.id,
      revision: Number(row.revision),
      name: row.name.slice(0, 200),
      source,
      preparation: row.preparation === 'unspecified' ? 'unknown' : row.preparation,
      basis: row.basis === 'per100g' ? { kind: 'per_100g', grams: '100' } : {
        kind: 'per_serving', grams: positiveDecimalSchema.safeParse(grams).success ? grams : null,
      },
      nutrients: readNutrients(row.nutrients),
      attribution: attribution(source.source, source.sourceRecordId),
      barcode: source.source === 'open_food_facts' ? source.sourceRecordId : null,
    };
  });
}

type Status = 'ok' | 'not_found' | 'unavailable';
const querySchema = z.string().trim().min(2).max(80);
const barcodeSchema = z.string().regex(/^(?:\d{8}|\d{12,14})$/);
const answer = (res: Response, data: CatalogFood[], status: Status = data.length ? 'ok' : 'not_found') =>
  res.json({ data, meta: { status, manualEntryAvailable: true } });
const invalid = (res: Response, message: string) =>
  res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, requestId: res.locals.requestId } });

function uniqueSources(foods: CatalogFood[]) {
  const seen = new Set<string>();
  return foods.filter(food => {
    const identity = `${food.source.source}:${food.source.sourceRecordId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function createFoodRouter(options: {
  db?: Pool;
  usdaApiKey?: string;
  openFoodFacts?: boolean;
  openFoodFactsUserAgent?: string;
  takeProviderBudget?: (provider: 'usda' | 'off') => Promise<boolean>;
}) {
  const router = Router();
  router.get('/search', async (req, res) => {
    const query = querySchema.safeParse(req.query.q);
    if (!query.success) return invalid(res, 'Enter a food name of 2–80 characters.');
    const local = fixtures.filter(food => food.name.toLowerCase().includes(query.data.toLowerCase()));
    if (options.db && typeof res.locals.userId === 'string')
      local.push(...await loadCatalogFoods(options.db, res.locals.userId, { query: query.data }));
    if (!options.usdaApiKey) return answer(res, uniqueSources(local));
    try {
      if (options.takeProviderBudget && !await options.takeProviderBudget('usda'))
        return answer(res, uniqueSources(local), 'unavailable');
      return answer(res, uniqueSources([...local, ...await lookupUsda(query.data, options.usdaApiKey)]));
    } catch {
      return answer(res, uniqueSources(local), 'unavailable');
    }
  });
  router.get('/barcode/:barcode', async (req, res) => {
    const barcode = barcodeSchema.safeParse(req.params.barcode);
    if (!barcode.success) return invalid(res, 'Enter an 8-, 12-, 13-, or 14-digit barcode.');
    const known = fixtures.find(food => food.barcode === barcode.data);
    if (known) return answer(res, [known]);
    if (!options.openFoodFacts) return answer(res, []);
    if (!options.openFoodFactsUserAgent) return answer(res, [], 'unavailable');
    try {
      if (options.takeProviderBudget && !await options.takeProviderBudget('off'))
        return answer(res, [], 'unavailable');
      const found = await lookupBarcode(barcode.data, options.openFoodFactsUserAgent);
      return answer(res, found ? [found] : []);
    } catch {
      return answer(res, [], 'unavailable');
    }
  });
  router.get('/:id', async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) return invalid(res, 'Enter a food ID.');
    const known = fixtures.find(food => food.id === id.data);
    if (known) return answer(res, [known]);
    const rows = options.db && typeof res.locals.userId === 'string'
      ? await loadCatalogFoods(options.db, res.locals.userId, { id: id.data })
      : [];
    return answer(res, rows);
  });
  return router;
}
