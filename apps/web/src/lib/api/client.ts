import { healthResponseSchema, type HealthResponse } from '@fit-tempo/contracts'

const configuredBase = import.meta.env?.VITE_API_BASE_URL ?? '/api/v1'
if (!/^\/api(?:\/[\w-]+)+\/?$/.test(configuredBase)) {
  throw new Error('VITE_API_BASE_URL must be a same-origin /api/ path')
}
export const apiBase = configuredBase.replace(/\/$/, '')

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${apiBase}/health`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error('The API health check is unavailable.')
  return healthResponseSchema.parse(await response.json())
}
