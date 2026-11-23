import { useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { ProductPhotoFrame } from '@/components/shared/ProductPhotoFrame';
import { Button } from '@/components/ui/button';
import { cameraAvailable, cameraError, rearCamera, stopCamera } from '@/lib/camera';

function captureFrame(video: HTMLVideoElement, zoom: number) {
  const { videoWidth, videoHeight, clientWidth, clientHeight } = video;
  if (!videoWidth || !videoHeight || !clientWidth || !clientHeight) return;
  const scale = Math.max(clientWidth / videoWidth, clientHeight / videoHeight) * zoom;
  const width = clientWidth / scale;
  const height = clientHeight / scale;
  const canvas = document.createElement('canvas');
  const outputScale = Math.min(1, 1600 / Math.max(width, height));
  canvas.width = Math.round(width * outputScale);
  canvas.height = Math.round(height * outputScale);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(video, (videoWidth - width) / 2, (videoHeight - height) / 2,
    width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

export default function ProductPhotoCamera({ onCapture, onSample }: {
  onCapture: (still: string) => void;
  onSample: () => void;
}) {
  const webcam = useRef<Webcam>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [focusMode, setFocusMode] = useState('');
  const [feedback, setFeedback] = useState('');
  const supported = cameraAvailable();
  return <>
    {supported && !error ? (
      <ProductPhotoFrame>
        <Webcam ref={webcam} audio={false} muted playsInline videoConstraints={rearCamera}
          aria-label="Live camera preview" className="absolute inset-0 size-full object-cover"
          style={{ transform: `scale(${zoom})` }}
          onUserMedia={stream => {
            const track = stream.getVideoTracks()[0];
            const modes = (track?.getCapabilities?.() as { focusMode?: string[] } | undefined)?.focusMode;
            setFocusMode(modes?.includes('single-shot') ? 'single-shot' : '');
          }}
          onLoadedData={() => setReady(true)} onUserMediaError={failure => setError(cameraError(failure))} />
        {!ready && <p role="status" className="absolute inset-0 grid place-items-center p-3 text-center text-sm">Starting camera…</p>}
      </ProductPhotoFrame>
    ) : error ? <p role="alert">{error}</p>
      : <p role="status">Camera capture requires a supported browser on HTTPS or localhost.</p>}
    {ready && !error && <div className="flex flex-wrap items-end gap-2">
      <label className="grid grow gap-1">Zoom ({zoom}×)
        <input type="range" min={1} max={3} step={0.25} value={zoom}
          onChange={event => setZoom(event.currentTarget.valueAsNumber)} />
      </label>
      {focusMode && <Button type="button" variant="outline" onClick={async () => {
        const track = webcam.current?.stream?.getVideoTracks()[0];
        if (!track) return;
        try {
          await track.applyConstraints({ advanced: [{ focusMode } as MediaTrackConstraintSet] });
          setFeedback('Focus requested. Hold steady before capturing.');
        } catch {
          setFeedback('Could not refocus. Move back slightly and try again.');
        }
      }}>Focus</Button>}
      {!focusMode && <p className="basis-full text-sm">Manual focus control is unavailable on this camera.</p>}
    </div>}
    {feedback && <p role="status">{feedback}</p>}
    <div className="flex flex-wrap gap-2">
      {supported && !error && <Button type="button" className="grow" disabled={!ready} onClick={() => {
        const video = webcam.current?.video;
        const still = video && captureFrame(video, zoom);
        if (!still) {
          setFeedback('Could not capture the photo. Try again.');
          return;
        }
        stopCamera(webcam.current?.stream);
        onCapture(still);
      }}>Take photo</Button>}
      <Button type="button" className="grow" variant="outline" onClick={onSample}>Use sample label</Button>
    </div>
  </>;
}
