import { FitTempoMark } from "./FitTempoBrand";
import { TempoCanvas } from "./TempoCanvas";
import { Skeleton } from "@/components/ui/skeleton";

export function AppLoadingPage() {
  return (
    <main className="tempo-canvas grid min-h-svh place-items-center px-4 py-8">
      <TempoCanvas />
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <FitTempoMark />
        <h1 role="status" className="text-xl font-semibold tracking-tight sm:text-2xl">Loading Fit Tempo</h1>
        <div aria-busy="true" className="w-full">
          <div aria-hidden="true" className="grid justify-items-center gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      </div>
    </main>
  );
}
