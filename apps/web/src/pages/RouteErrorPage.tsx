import { Link } from 'react-router-dom'

export function RouteErrorPage() {
  return (
    <main className="mx-auto grid min-h-svh max-w-6xl content-start px-5 py-12 sm:px-8">
      <div className="space-y-4 border-t border-border pt-6">
        <h1 className="text-3xl font-semibold tracking-tight">This page is unavailable</h1>
        <Link className="font-medium text-accent underline underline-offset-4" to="/">Return to Fit Tempo</Link>
      </div>
    </main>
  )
}
