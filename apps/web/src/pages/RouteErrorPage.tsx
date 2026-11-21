import { TempoCanvas } from '@/components/shared/TempoCanvas';
import { GlassPanel } from '@/components/shared/GlassPanel';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom'

export function RouteErrorPage() {
  return (
    <main className="tempo-canvas mx-auto grid min-h-svh max-w-6xl content-start px-5 py-12 sm:px-8">
      <TempoCanvas />
      <div className="max-w-xl space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">This page is unavailable</h1>
        <GlassPanel tone="solid">
          <Button asChild><Link to="/">Return to Fit Tempo</Link></Button>
        </GlassPanel>
      </div>
    </main>
  )
}
