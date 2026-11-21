import { useId, type ReactNode } from 'react'

type GlassPanelProps = {
  title?: ReactNode
  tone?: 'glass' | 'solid'
  status?: ReactNode
  action?: ReactNode
  footer?: ReactNode
  children: ReactNode
  className?: string
}

export function GlassPanel({ title, tone = 'glass', status, action, footer, children, className = '' }: GlassPanelProps) {
  const titleId = useId()
  const hasHeader = title != null || status != null || action != null
  return <section aria-labelledby={title != null ? titleId : undefined} className={`glass-panel ${tone === 'solid' ? 'glass-solid' : ''} ${className}`}>
    {hasHeader && <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      {title != null && <h2 id={titleId}>{title}</h2>}
      {(status != null || action != null) && <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{status}{action}</div>}
    </header>}
    <div className={`min-w-0 ${hasHeader ? 'mt-4' : ''}`}>{children}</div>
    {footer != null && <footer className="mt-4">{footer}</footer>}
  </section>
}
