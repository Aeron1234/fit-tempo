export const labelNutrients = {
  energyKcal: 'Energy (kcal)', proteinG: 'Protein (g)', carbsG: 'Carbohydrates (g)',
  fatG: 'Fat (g)', fiberG: 'Fiber (g)', sodiumMg: 'Sodium (mg)',
} as const;

export type ProductLabel = {
  basis: 'per_serving' | 'per_100g';
  grams: string;
  nutrients: Record<keyof typeof labelNutrients, string>;
};

export const sampleProduct = {
  name: 'Sample oat crisps',
  label: {
    basis: 'per_serving',
    grams: '40',
    nutrients: { energyKcal: '160', proteinG: '4', carbsG: '26', fatG: '5', fiberG: '', sodiumMg: '0' },
  } satisfies ProductLabel,
};

const labelRows = [
  sampleProduct.name,
  'Serving size 40 g',
  'Energy 160 kcal',
  'Protein 4 g',
  'Carbohydrates 26 g',
  'Fat 5 g',
  'Sodium 0 mg',
];
export const sampleLabelPreview = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="224" viewBox="0 0 320 224">' +
  '<rect width="320" height="224" fill="#fff"/><g fill="#0e2a47" font-family="sans-serif" font-size="17">' +
  labelRows.map((line, index) => `<text x="18" y="${32 + index * 27}">${line}</text>`).join('') + '</g></svg>',
);

export type ProductPhoto = { kind: 'sample' } | { kind: 'camera'; preview: string };

// Only the approved mock identifier crosses the analysis boundary. No image is sent.
export function analyzeProductPhoto(photo: ProductPhoto, mock: (id: 'sample-oat-crisps') => typeof sampleProduct = () => structuredClone(sampleProduct)) {
  if (photo.kind !== 'sample') throw new Error('Analysis of camera photos is unavailable.');
  return mock('sample-oat-crisps');
}
