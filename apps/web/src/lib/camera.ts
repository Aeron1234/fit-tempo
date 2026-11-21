export const rearCamera = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } };

export function cameraAvailable() {
  return globalThis.isSecureContext === true && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';
}

export function cameraError(error: unknown) {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? error.kind : '';
  if (name === 'NotAllowedError' || kind === 'permission-denied' || kind === 'security') return 'Camera permission was denied.';
  if (name === 'NotFoundError' || kind === 'no-camera') return 'No camera was found.';
  if (name === 'NotReadableError' || kind === 'in-use') return 'The camera may be in use by another app.';
  return 'The camera could not start or read the image.';
}

export function stopCamera(stream: Pick<MediaStream, 'getTracks'> | null | undefined) {
  stream?.getTracks().forEach(track => track.stop());
}
