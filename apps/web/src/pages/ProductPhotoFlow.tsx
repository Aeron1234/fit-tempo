import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CameraDialog } from '@/components/shared/CameraDialog';
import { ProductPhotoFrame } from '@/components/shared/ProductPhotoFrame';
import { Button } from '@/components/ui/button';
import { analyzeProductPhoto, sampleLabelPreview, type ProductLabel, type ProductPhoto } from './product-photo';

const ProductPhotoCamera = lazy(() => import('@/components/shared/ProductPhotoCamera'));
type LabelDraft = { name: string; label: ProductLabel; labelSource: 'camera' | 'sample' };

function Capture({ done }: { done: (draft: LabelDraft) => void }) {
  const [photo, setPhoto] = useState<ProductPhoto | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (photo) previewHeading.current?.focus();
  }, [photo]);
  return photo ? <>
    <h3 ref={previewHeading} tabIndex={-1} className="font-semibold">Review photo</h3>
    <ProductPhotoFrame>
      <img src={photo.kind === 'camera' ? photo.preview : sampleLabelPreview} alt={photo.kind === 'camera' ? 'Captured product label' : 'Fictional oat crisps label'}
        className="absolute inset-0 size-full object-contain" />
    </ProductPhotoFrame>
    {reading && <p role="status">Reading nutrition label…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={reading} onClick={() => { setError(''); setPhoto(null); }}>Retake</Button>
      <Button type="button" disabled={reading} onClick={async () => {
        setError('');
        setReading(true);
        try {
          if (photo.kind === 'sample') {
            done({ ...analyzeProductPhoto(photo), labelSource: 'sample' });
            return;
          }
          const { readNutritionLabel } = await import('./read-nutrition-label');
          const label = await readNutritionLabel(photo.preview);
          if (!mounted.current) return;
          if (label) done({ name: '', label, labelSource: 'camera' });
          else setError('Use a clear photo of a Nutrition Facts panel with one column of values.');
        } catch {
          if (mounted.current) setError('Label reading failed. Try again or log the meal manually.');
        } finally {
          if (mounted.current) setReading(false);
        }
      }}>Analyze</Button>
    </div>
  </> : <>
    <Suspense fallback={<p role="status">Loading camera.</p>}>
      <ProductPhotoCamera onCapture={preview => setPhoto({ kind: 'camera', preview })}
        onSample={() => setPhoto({ kind: 'sample' })} />
    </Suspense>
  </>;
}

export function ProductPhotoFlow({ disabled, onDraft }: { disabled: boolean; onDraft: (draft: LabelDraft) => void }) {
  return <CameraDialog title="Nutrition label photo" action="Scan nutrition label" disabled={disabled}
    description="Fit the serving size and nutrient values inside the frame. Your photo stays on this device.">
    {close => <Capture done={draft => { onDraft(draft); close(); }} />}
  </CameraDialog>;
}
