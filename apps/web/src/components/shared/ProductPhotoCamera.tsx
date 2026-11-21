import { useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { Button } from '@/components/ui/button';
import { cameraAvailable, cameraError, rearCamera, stopCamera } from '@/lib/camera';

export default function ProductPhotoCamera({ onCapture }: { onCapture: (still: string) => void }) {
  const webcam = useRef<Webcam>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  if (!cameraAvailable()) return <p role="status">Camera capture requires a supported browser on HTTPS or localhost. Try the sample label below.</p>;
  if (error) return <p role="alert">{error} Try the sample label below.</p>;
  return <>
    <Webcam ref={webcam} audio={false} muted playsInline videoConstraints={rearCamera}
      screenshotFormat="image/jpeg" screenshotQuality={0.85} aria-label="Live camera preview"
      className="max-h-64 w-full rounded-md object-contain"
      onUserMedia={() => setReady(true)} onUserMediaError={failure => setError(cameraError(failure))} />
    <Button type="button" disabled={!ready} onClick={() => {
      const still = webcam.current?.getScreenshot();
      if (!still) return;
      stopCamera(webcam.current?.stream);
      onCapture(still);
    }}>Take photo</Button>
  </>;
}
