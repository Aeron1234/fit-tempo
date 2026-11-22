import { useEffect, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { FitTempoBrand } from "./FitTempoBrand";
import { TempoCanvas } from "./TempoCanvas";

export function StatusPage({ title, description, icon: Icon, children }: {
  title: string;
  description: string;
  icon: LucideIcon;
  children?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [title]);

  return (
    <main className="tempo-canvas grid min-h-svh place-items-center px-4 py-8 sm:px-6">
      <TempoCanvas />
      <section aria-labelledby="status-heading" className="w-full min-w-0 max-w-lg rounded-2xl border border-border bg-card p-5 sm:p-8">
        <FitTempoBrand />
        <div className="mt-6 space-y-3">
          <span className="grid size-11 place-items-center rounded-xl bg-muted text-accent">
            <Icon size={22} aria-hidden="true" />
          </span>
          <h1 ref={heading} id="status-heading" tabIndex={-1} className="text-2xl font-bold tracking-tight sm:text-3xl">
            {title}
          </h1>
          <p className="break-words text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {children && <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>}
      </section>
    </main>
  );
}
