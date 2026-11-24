import { Skeleton } from '@/components/ui/skeleton'
import { GlassPanel } from './GlassPanel'

type Shape = 'rows' | 'ledger' | 'form' | 'chart' | 'week' | 'strip' | 'table' | 'camera'

export function LoadingSkeleton({ label, shape = 'rows', count }: {
  label: string
  shape?: Shape
  count?: number
}) {
  const rows = Array.from({ length: count ?? (shape === 'week' ? 7 : 3) }, (_, index) => index)
  return <>
    <span role="status" className="sr-only">{label}</span>
    <div aria-busy="true" className="min-w-0">
      <div aria-hidden="true">
        {shape === 'chart' && <Skeleton className="h-56 w-full" />}
        {shape === 'camera' && <Skeleton className="aspect-[4/3] max-h-[48dvh] w-full" />}
        {shape === 'strip' && <div className="space-y-3 py-3">
          <div className="flex justify-between">{rows.map(index => <Skeleton key={index} className="size-7 rounded-full" />)}</div>
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-5 w-32" />
        </div>}
        {shape === 'form' && <div className="grid gap-3">{rows.map(index => <div key={index} className="space-y-1">
          <Skeleton className="h-4 w-24" /><Skeleton className="h-11 w-full" />
        </div>)}</div>}
        {shape === 'table' && <div className="divide-y divide-border">{[0, ...rows.map(row => row + 1)].map(row =>
          <div key={row} className="grid grid-cols-3 gap-3 py-3">
            <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" />
          </div>)}</div>}
        {(shape === 'rows' || shape === 'ledger' || shape === 'week') &&
          <div className="divide-y divide-border">{rows.map(index => <div key={index}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/5 max-w-48" />
              {shape !== 'ledger' && <Skeleton className="h-3 w-2/5 max-w-28" />}
            </div>
            {shape !== 'week' && <Skeleton className={shape === 'ledger' ? 'h-4 w-16' : 'h-9 w-16 sm:w-24'} />}
          </div>)}</div>}
      </div>
    </div>
  </>
}

export function LazyRouteSkeleton({ activity = false }: { activity?: boolean }) {
  const title = activity ? 'Activity and progress' : 'Weekly analytics'
  return <div className="tempo-card-grid min-w-0">
    <h1 className="text-3xl font-semibold">{title}</h1>
    <GlassPanel tone="solid"><LoadingSkeleton label={`Loading ${title.toLowerCase()}.`} shape="form" count={activity ? 3 : 1} /></GlassPanel>
    {!activity && <GlassPanel title="Week comparison">
      <LoadingSkeleton label="Preparing the weekly comparison." shape="ledger" count={6} />
    </GlassPanel>}
    <div className="tempo-dashboard-panels">
      {(activity ? ['Weight trend', 'Measurement trends'] : ['Nutrition by date', 'Hydration by date']).map(heading =>
        <GlassPanel key={heading} title={heading} tone="solid">
          <LoadingSkeleton label={`Preparing ${heading.toLowerCase()}.`} shape="chart" />
        </GlassPanel>)}
    </div>
  </div>
}
