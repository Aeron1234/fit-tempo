import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/shared/GlassPanel";
import { FitTempoBrand } from "@/components/shared/FitTempoBrand";
import { getHealth } from "@/lib/api/client";

export function ScaffoldPage() {
  const [count, setCount] = useState(0);
  const health = useQuery({
    queryKey: ["public", "health"],
    queryFn: ({ signal }) => getHealth(signal),
    retry: false,
  });

  return (
    <div className="mx-auto flex min-h-svh max-w-6xl flex-col gap-4 px-4 py-8 md:gap-5 md:px-6">
      <header className="flex items-center gap-3 text-foreground">
        <FitTempoBrand />
      </header>
      <section className="max-w-2xl space-y-5">
        <p className="text-sm font-medium text-muted-foreground">
          Development preview
        </p>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
          Your meals. Your movement. Your rhythm.
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
          The web and API foundation is being prepared. Personal tracking will
          become available in later development phases.
        </p>
      </section>
      <GlassPanel title="API connection" className="max-w-xl">
        <div
          className="my-4 min-h-12 text-sm text-muted-foreground"
          aria-live="polite"
        >
          {health.isPending && <p>Checking the local API…</p>}
          {health.isError && (
            <p role="alert">API unavailable. Start the API server and retry.</p>
          )}
          {health.isSuccess && (
            <p>
              Connected · {health.data.data.mode} mode. AI is off; email and
              scheduling use development tools.
            </p>
          )}
        </div>
        <Button
          variant="outline"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
        >
          <RefreshCw aria-hidden="true" size={16} /> Check connection
        </Button>
      </GlassPanel>
      <GlassPanel title="Development interaction check" tone="solid" className="max-w-xl">
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <Button variant="outline" onClick={() => setCount((value) => value + 1)}>
            Interaction check: {count}
          </Button>
          <p>Use this counter to verify state survives a component edit.</p>
        </div>
      </GlassPanel>
    </div>
  );
}
