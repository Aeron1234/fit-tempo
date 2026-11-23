import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CameraDialog } from '@/components/shared/CameraDialog';
import { ProductPhotoFrame } from '@/components/shared/ProductPhotoFrame';
import { Button } from '@/components/ui/button';
import { analyzeProductPhoto, sampleLabelPreview, type ProductPhoto, type sampleProduct } from './product-photo';

const ProductPhotoCamera = lazy(() => import('@/components/shared/ProductPhotoCamera'));

function Capture({ done }: { done: (draft: typeof sampleProduct) => void }) {
  const [photo, setPhoto] = useState<ProductPhoto | null>(null);
  const [error, setError] = useState('');
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
    {photo.kind === 'camera' && <p className="text-sm text-muted-foreground">Your photo stays on this device. Analysis of camera photos is unavailable.</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" onClick={() => { setError(''); setPhoto(null); }}>Retake</Button>
      <Button type="button" disabled={photo.kind !== 'sample'} onClick={() => {
        try { done(analyzeProductPhoto(photo)); }
        catch { setError('Label analysis failed. You can retake or log a meal manually.'); }
      }}>Analyze</Button>
    </div>
  </> : <>
    <Suspense fallback={<p role="status">Loading camera.</p>}>
      <ProductPhotoCamera onCapture={preview => setPhoto({ kind: 'camera', preview })}
        onSample={() => setPhoto({ kind: 'sample' })} />
    </Suspense>
  </>;
}

export function ProductPhotoFlow({ disabled, onDraft }: { disabled: boolean; onDraft: (draft: typeof sampleProduct) => void }) {
  return <CameraDialog title="Product label photo" action="Capture product photo" disabled={disabled}
    description="Center the label in the camera preview. Your photo stays on this device.">
    {close => <Capture done={draft => { onDraft(draft); close(); }} />}
  </CameraDialog>;
}
