import { createWorker } from 'tesseract.js';
import workerPath from 'tesseract.js/dist/worker.min.js?url';
import type { ProductLabel } from './product-photo';

export function parseNutritionLabel(text: string): ProductLabel | null {
  if (!/nutrition\s+(?:facts|information)|serving\s+size/i.test(text)) return null;
  const per100 = /\bper\s+100\s*g\b/i.test(text);
  if (per100 && /\bper\s+serving\b/i.test(text)) return null;
  const number = '(\\d+(?:[.,]\\d{1,2})?)';
  const read = (label: string, units: string) => {
    const match = text.match(new RegExp(`^\\s*(?:${label})\\s*[:(]?\\s*${number}\\s*(?:${units})`, 'im'));
    return match?.[1]?.replace(',', '.') ?? '';
  };
  const nutrients = {
    energyKcal: read('energy', 'kcal\\b') || read('calories', '(?:kcal\\b|$|(?=\\s+%))'),
    proteinG: read('protein', 'g\\b'),
    carbsG: read('(?:total )?carbohydrates?', 'g\\b'),
    fatG: read('(?:total )?fat', 'g\\b'),
    fiberG: read('(?:dietary )?fib[er]{2}', 'g\\b'),
    sodiumMg: read('sodium', 'mg\\b'),
  };
  if (!Object.values(nutrients).some(Boolean)) return null;
  const serving = text.match(/serving\s+size[^\r\n]*?\b(\d+(?:[.,]\d{1,2})?)\s*g\b/i)?.[1];
  return { basis: per100 ? 'per_100g' : 'per_serving', grams: per100 ? '100' : serving?.replace(',', '.') ?? '', nutrients };
}

export async function readNutritionLabel(image: string) {
  const worker = await createWorker('eng', 1, { workerPath, workerBlobURL: false });
  try {
    const { data } = await worker.recognize(image);
    return parseNutritionLabel(data.text);
  } finally {
    await worker.terminate();
  }
}
