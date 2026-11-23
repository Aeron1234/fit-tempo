import { useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { Button } from '@/components/ui/button';
import { cameraAvailable, cameraError, rearCamera, stopCamera } from '@/lib/camera';

export default function ProductPhotoCamera({ onCapture, onSample }: {
  onCapture: (still: string) => void;
  onSample: () => void;
}) {
  const webcam = useRef<Webcam>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const supported = cameraAvailable();
  return <>
    {supported && !error ? (
      <div className="relative mx-auto aspect-[3/4] max-h-[55dvh] w-full max-w-xs overflow-hidden rounded-xl bg-muted md:aspect-[4/3] md:max-w-none">
        <Webcam ref={webcam} audio={false} muted playsInline videoConstraints={rearCamera}
          forceScreenshotSourceSize screenshotFormat="image/jpeg" screenshotQuality={0.85}
          aria-label="Live camera preview" className="absolute inset-0 size-full object-cover"
          onLoadedData={() => setReady(true)} onUserMediaError={failure => setError(cameraError(failure))} />
        {!ready && <p role="status" className="absolute inset-0 grid place-items-center p-3 text-center text-sm">Starting camera…</p>}
      </div>
    ) : error ? <p role="alert">{error}</p>
      : <p role="status">Camera capture requires a supported browser on HTTPS or localhost.</p>}
    <div className="flex flex-wrap gap-2">
      {supported && !error && <Button type="button" className="grow" disabled={!ready} onClick={() => {
        const still = webcam.current?.getScreenshot();
        if (!still) return;
        stopCamera(webcam.current?.stream);
        onCapture(still);
      }}>Take photo</Button>}
      <Button type="button" className="grow" variant="outline" onClick={onSample}>Use sample label</Button>
    </div>
  </>;
}
