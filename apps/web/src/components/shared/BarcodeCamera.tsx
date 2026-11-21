import { useRef, useState } from 'react';
import { Scanner, setZXingModuleOverrides, type IScannerHandle } from '@yudiel/react-qr-scanner';
import decoderUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { cameraAvailable, cameraError, rearCamera, stopCamera } from '@/lib/camera';
import { createRetailScan, retailFormats } from '@/lib/retail-barcode';

setZXingModuleOverrides({ locateFile: (file, base) => file.endsWith('.wasm') ? decoderUrl : base + file });
const formats = [...retailFormats];

export default function BarcodeCamera({ onBarcode }: { onBarcode: (code: string) => void }) {
  const scanner = useRef<IScannerHandle>(null);
  const [error, setError] = useState('');
  const [scan] = useState(createRetailScan);
  if (!cameraAvailable()) return <p role="status">Camera scanning requires a supported browser on HTTPS or localhost. Enter the barcode manually.</p>;
  if (error) return <p role="alert">{error} Enter the barcode manually.</p>;
  return <div className="overflow-hidden rounded-md bg-card">
    <Scanner ref={scanner} constraints={rearCamera} formats={formats} allowMultiple={false}
      onScan={codes => {
        if (!scanner.current) return;
        const code = scan(codes);
        if (!code) return;
        stopCamera(scanner.current.getStream());
        onBarcode(code);
      }}
      onError={failure => {
        stopCamera(scanner.current?.getStream());
        setError(cameraError(failure));
      }} sound={false} styles={{ container: { aspectRatio: '4 / 3' } }} />
  </div>;
}
