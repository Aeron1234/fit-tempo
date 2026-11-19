import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getHealth } from "@/lib/api/client";

export function ScaffoldPage() {
  const [count, setCount] = useState(0);
  const health = useQuery({
    queryKey: ["public", "health"],
    queryFn: ({ signal }) => getHealth(signal),
    retry: false,
  });

  return (
    <main className="mx-auto flex min-h-svh max-w-6xl flex-col gap-10 px-6 py-12">
      <header className="flex items-center gap-3 text-foreground">
        <span className="text-xl font-semibold tracking-tight">Fit Tempo</span>
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
      <section
        aria-labelledby="connection-title"
        className="max-w-xl border-t border-border pt-6"
      >
        <h2 id="connection-title" className="text-lg font-semibold">
          API connection
        </h2>
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
      </section>
      <section
        className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground"
        aria-label="Development interaction check"
      >
        <Button onClick={() => setCount((value) => value + 1)}>
          Interaction check: {count}
        </Button>
        <p>Use this counter to verify state survives a component edit.</p>
      </section>
    </main>
  );
}
