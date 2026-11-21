import type { ReactElement, ReactNode } from 'react'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { GlassPanel } from './GlassPanel'

export function ChartCard({ title, config, children, tone = 'solid', action, footer, className, chartClassName = 'h-56' }: {
  title: ReactNode
  config: ChartConfig
  children?: ReactElement
  tone?: 'solid' | 'glass'
  action?: ReactNode
  footer?: ReactNode
  className?: string
  chartClassName?: string
}) {
  return <GlassPanel title={title} tone={tone} action={action} footer={footer} className={className}>
    {children != null && <ChartContainer config={config} className={chartClassName}>{children}</ChartContainer>}
  </GlassPanel>
}
