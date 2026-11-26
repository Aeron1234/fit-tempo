import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { createAppRouter } from '@/app/router'
import { createSession } from '@/lib/api/session'
import { ConnectionBoundary, initializePwa } from '@/app/pwa'
import '@/index.css'

const queryClient = new QueryClient()
initializePwa()
const router = createAppRouter(createSession(queryClient))
const root = document.getElementById('root')
if (!root) throw new Error('Application root is missing')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionBoundary><RouterProvider router={router} /></ConnectionBoundary>
    </QueryClientProvider>
  </StrictMode>,
)
