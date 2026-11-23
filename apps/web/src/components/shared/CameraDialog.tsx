import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function CameraDialog({ title, action, description, children, disabled }: {
  title: string;
  action: string;
  description: string;
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const descriptionId = useId();
  function close() {
    setOpen(false);
  }
  useEffect(() => {
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <>
    <Button type="button" variant="outline" disabled={disabled} onClick={() => {
      dialog.current?.showModal();
      setOpen(Boolean(dialog.current?.open));
    }}>{action}</Button>
    <dialog ref={dialog} aria-labelledby={labelId} aria-describedby={descriptionId}
      className="tempo-picker-sheet glass-float glass-solid fixed inset-x-0 bottom-0 top-auto m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:inset-0 md:m-auto md:h-fit md:max-w-lg"
      onClose={() => setOpen(false)} onCancel={close}>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <h2 id={labelId} className="min-w-0 self-center text-xl font-semibold">{title}</h2>
          <Button type="button" variant="outline" className="shrink-0" onClick={close}>Cancel</Button>
        </div>
        <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>
        {open && children(close)}
      </div>
    </dialog>
  </>;
}
