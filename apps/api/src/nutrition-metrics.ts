import type { Pool, PoolClient } from 'pg';
import { aggregateDay, decimalSchema } from '@fit-tempo/contracts';

type Row = {
  date: string;
  status: 'unrecorded' | 'partial' | 'complete' | null;
  entry_count: number | null;
  timezone: string | null;
  meal_id: string | null;
  item_id: string | null;
  calories: unknown;
  protein: unknown;
};
function nutrient(value: unknown) {
  const result = decimalSchema.safeParse(value);
  return result.success ? result.data : null;
}

export async function readNutritionDays(db: Pool | PoolClient, owner: string, from: string, to: string, timeZone: string) {
  const result = await db.query<Row>(`
    WITH scope AS (
      SELECT day::date AS day FROM generate_series($2::date::timestamp,$3::date::timestamp,interval '1 day') day
    )
    SELECT scope.day::text AS date, status.state AS status, status.entry_count,
      COALESCE(status.recorded_time_zone, meal.recorded_time_zone) AS timezone,
      meal.id AS meal_id, item.id AS item_id,
      item.nutrition_snapshot #> '{consumedNutrients,energyKcal}' AS calories,
      item.nutrition_snapshot #> '{consumedNutrients,proteinG}' AS protein
    FROM scope
    LEFT JOIN daily_tracking_status status ON status.user_id=$1 AND status.recorded_local_date=scope.day
      AND status.category='nutrition'
    LEFT JOIN meals meal ON meal.user_id=$1 AND meal.recorded_local_date=scope.day AND meal.deleted_at IS NULL
    LEFT JOIN meal_items item ON item.meal_id=meal.id
    ORDER BY scope.day,meal.occurred_at,meal.id,item.id
  `, [owner, from, to]);
  const groups = new Map<string, Row[]>();
  for (const row of result.rows) {
    const group = groups.get(row.date);
    if (group) group.push(row);
    else groups.set(row.date, [row]);
  }
  return [...groups].map(([date, rows]) => {
    const first = rows[0]!;
    const hasEntries = Boolean(first.meal_id || first.entry_count);
    const status = first.status === 'complete' ? 'complete' : hasEntries ? 'partial' : 'unrecorded';
    return aggregateDay({
      date, timezone: first.timezone ?? timeZone, status, hasEntries,
      items: rows.filter(row => row.item_id).map(row => ({ calories: nutrient(row.calories), protein: nutrient(row.protein) })),
    });
  });
}
