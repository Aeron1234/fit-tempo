import type { ReactNode } from 'react';

export function ProductPhotoFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative mx-auto aspect-[3/4] max-h-[48dvh] w-full max-w-xs overflow-hidden rounded-xl border border-border bg-muted md:aspect-[4/3] md:max-w-none">
      {children}
    </div>
  );
}
