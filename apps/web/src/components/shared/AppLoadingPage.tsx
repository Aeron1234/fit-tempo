import { FitTempoMark } from "./FitTempoBrand";
import { TempoCanvas } from "./TempoCanvas";

export function AppLoadingPage() {
  return (
    <main className="tempo-canvas grid min-h-svh place-items-center px-4 py-8">
      <TempoCanvas />
      <div role="status" className="flex max-w-sm flex-col items-center gap-5 text-center">
        <div className="relative grid size-20 place-items-center" aria-hidden="true">
          <span className="absolute inset-0 rounded-full border-2 border-control-border border-t-accent motion-safe:animate-spin" />
          <FitTempoMark />
        </div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Loading Fit Tempo</h1>
      </div>
    </main>
  );
}
