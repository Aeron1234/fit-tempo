import type { ReactNode } from 'react';

export function ProductPhotoFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative aspect-[4/3] max-h-[48dvh] w-full overflow-hidden rounded-xl bg-muted">
      {children}
    </div>
  );
}
