import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiBase } from './client'

const userResponse = z.object({
  data: z.object({ id: z.string().min(1), role: z.enum(['trainee', 'admin']) }),
})
const csrfResponse = z.object({ data: z.object({ csrfToken: z.string().min(1) }) })
const errorResponse = z.object({ error: z.object({ code: z.string() }) })
type User = z.infer<typeof userResponse>['data']

export type SessionSnapshot =
  | { status: 'checking' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: User }
  | { status: 'error'; message: string }

const lockName = 'fit-tempo-session'
const unavailable = 'The session could not be checked. Please try again.'

function send(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  return fetch(`${apiBase}${path}`, {
    ...options,
    headers,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
  })
}

async function readUser(signal = AbortSignal.timeout(6000)) {
  const response = await send('/auth/me', { signal })
  if (response.status === 401) return null
  if (!response.ok) throw new Error(unavailable)
  return userResponse.parse(await response.json()).data
}

type PrivateMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE'

async function submitOnce(path: string, body?: object, signal?: AbortSignal, method: PrivateMethod = 'POST') {
  const csrf = await send('/auth/csrf', { signal: signal ?? AbortSignal.timeout(5000) })
  if (!csrf.ok) throw new Error(unavailable)
  const { csrfToken } = csrfResponse.parse(await csrf.json()).data
  return send(path, {
    method,
    headers: {
      'X-CSRF-Token': csrfToken,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(8000),
  })
}

async function submit(path: string, body?: object, signal?: AbortSignal) {
  const response = await submitOnce(`/auth/${path}`, body, signal)
  if (response.status !== 403) return response
  const error = errorResponse.safeParse(await response.clone().json().catch(() => null))
  // The CSRF guard rejects before the endpoint can change state.
  if (error.success && error.data.error.code === 'CSRF_INVALID' && !signal?.aborted)
    return submitOnce(`/auth/${path}`, body, signal)
  return response
}

function requestError(response: Response, fallback: string) {
  return new Error(response.status === 429 ? 'Too many requests. Please try again later.' : fallback)
}

async function refresh() {
  // The API can recover one lost refresh response within its 10-second grace window.
  const recoveryWindow = AbortSignal.timeout(8000)
  let response: Response
  try {
    response = await submit('refresh', undefined, AbortSignal.timeout(4500))
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error
    recoveryWindow.throwIfAborted()
    const recovered = await readUser(recoveryWindow)
    if (recovered) return recovered
    recoveryWindow.throwIfAborted()
    response = await submit('refresh', undefined, recoveryWindow)
  }
  if (response.status === 401) return null
  if (!response.ok) throw requestError(response, unavailable)
  const user = await readUser()
  if (!user) throw new Error(unavailable)
  return user
}

export function createSession(queryClient: QueryClient) {
  let snapshot: SessionSnapshot = { status: 'checking' }
  let identity: User | null = null
  let generation = 0
  let inProgress: Promise<void> | undefined
  let transitions = 0
  let localQueue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(lockName)

  function publish(next: SessionSnapshot) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  function clearPrivateState() {
    generation++
    identity = null
    void queryClient.cancelQueries()
    queryClient.clear()
  }

  function setIdentity(user: User | null) {
    if (identity?.id !== user?.id || identity?.role !== user?.role) clearPrivateState()
    identity = user
    publish(user ? { status: 'authenticated', user } : { status: 'anonymous' })
  }

  async function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    if (locks) return await locks.request(lockName, task)
    const next = localQueue.then(task)
    localQueue = next.catch(() => undefined)
    return next
  }

  async function detectSession() {
    const user = await readUser()
    if (user) return user
    if (typeof navigator === 'undefined' || !navigator.locks) {
      // A browser without a cross-tab lock can sign in, but must not race cookie rotation.
      return null
    }
    return refresh()
  }

  function initialize() {
    if (transitions) return Promise.resolve()
    if (inProgress) return inProgress
    inProgress = exclusive(async () => {
      if (transitions) return
      const expected = generation
      try {
        const user = await detectSession()
        if (generation === expected) setIdentity(user)
      } catch {
        if (generation === expected) {
          clearPrivateState()
          publish({ status: 'error', message: unavailable })
        }
      }
    }).finally(() => { inProgress = undefined })
    return inProgress
  }

  function transition(task: () => Promise<User | null>) {
    transitions++
    clearPrivateState()
    publish({ status: 'checking' })
    return exclusive(async () => {
      channel?.postMessage('changing')
      try {
        const user = await task()
        if (transitions === 1) setIdentity(user)
      } catch (error) {
        if (transitions === 1)
          publish({ status: 'error', message: error instanceof Error ? error.message : unavailable })
        throw error
      } finally {
        transitions--
        channel?.postMessage('changed')
      }
    })
  }

  async function runMutation(path: string, body: object | undefined, fallback: string) {
    let response: Response
    try {
      response = await submit(path, body)
    } catch {
      throw new Error('The request could not be confirmed. Please check your connection.')
    }
    if (!response.ok) throw requestError(response, fallback)
  }

  if (channel) {
    channel.onmessage = ({ data }) => {
      if (data !== 'changing' && data !== 'changed') return
      clearPrivateState()
      publish({ status: 'checking' })
      // Wait for any check invalidated above before starting a new one under the lock.
      void Promise.resolve(inProgress).then(initialize)
    }
  }

  const revalidateIfVisible = () => {
    if (document.visibilityState !== 'visible') return
    if (snapshot.status === 'authenticated') publish({ status: 'checking' })
    void initialize()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', revalidateIfVisible)
  if (typeof window !== 'undefined') window.addEventListener('pageshow', revalidateIfVisible)

  async function privateRequest<T>(
    path: string, parse: (body: unknown) => T, signal?: AbortSignal,
    mutation?: { method: PrivateMethod; body: object },
  ): Promise<T> {
    const pathname = path.split('?')[0]
    if (!/^\/(?:me|foods)(?:\/[\w-]+)*$/.test(pathname) || path.includes('#'))
      throw new Error('Invalid private API path.')
    const expected = generation
    const user = identity
    const checkCurrent = () => {
      signal?.throwIfAborted()
      if (!user || snapshot.status !== 'authenticated' || generation !== expected)
        throw new Error('The session changed. Please try again.')
    }
    checkCurrent()
    return exclusive(async () => {
      checkCurrent()
      const current = await detectSession()
      checkCurrent()
      if (!current || current.id !== user?.id || current.role !== user.role) {
        setIdentity(current)
        throw new Error('The session changed. Please try again.')
      }
      const deadline = AbortSignal.timeout(8000)
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      const response = mutation
        ? await submitOnce(path, mutation.body, requestSignal, mutation.method)
        : await send(path, { signal: requestSignal })
      checkCurrent()
      if (response.status === 401) {
        setIdentity(null)
        throw new Error('The session changed. Please sign in again.')
      }
      if (!response.ok) {
        const failure = requestError(response, mutation ? 'Changes could not be saved.' : 'The requested data is unavailable.')
        const parsed = errorResponse.safeParse(await response.json().catch(() => null))
        const code = parsed.success ? parsed.data.error.code : undefined
        checkCurrent()
        throw Object.assign(failure, { status: response.status, code })
      }
      const data = parse(await response.json())
      checkCurrent()
      return data
    })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    initialize,
    revalidate: initialize,
    dispose() {
      channel?.close()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', revalidateIfVisible)
      if (typeof window !== 'undefined') window.removeEventListener('pageshow', revalidateIfVisible)
      listeners.clear()
    },
    signIn(email: string, password: string) {
      return transition(async () => {
        await runMutation('login', { email, password }, 'Unable to sign in. Check your credentials and verify your email.')
        const user = await readUser().catch(() => { throw new Error(unavailable) })
        if (!user) throw new Error(unavailable)
        return user
      })
    },
    signOut() {
      return transition(async () => {
        await runMutation('logout', undefined, 'Unable to confirm sign-out. Please try again.')
        return null
      })
    },
    register(email: string, password: string) {
      return exclusive(() => runMutation('register', { email, password }, 'Unable to submit registration. Please check the form.'))
    },
    verifyEmail(token: string) {
      return exclusive(() => runMutation('verify-email', { token }, 'This verification link is invalid or expired.'))
    },
    resendVerification(email: string) {
      return exclusive(() => runMutation('resend-verification', { email }, 'Unable to submit the verification request.'))
    },
    requestPasswordReset(email: string) {
      return exclusive(() => runMutation('forgot-password', { email }, 'Unable to submit the reset request.'))
    },
    resetPassword(token: string, password: string) {
      return transition(async () => {
        await runMutation('reset-password', { token, password }, 'Unable to reset your password. Check that the link is still valid.')
        return null
      })
    },
    requestPrivate<T>(path: string, parse: (body: unknown) => T, signal?: AbortSignal) {
      return privateRequest(path, parse, signal)
    },
    mutatePrivate<T>(path: '/me/profile' | '/me/preferences', body: object, parse: (body: unknown) => T) {
      return privateRequest(path, parse, undefined, { method: 'PATCH', body })
    },
    mutateMeal<T>(method: PrivateMethod, path: string, body: object, parse: (body: unknown) => T) {
      return privateRequest(path, parse, undefined, { method, body })
    },
    createManualFood<T>(body: object, parse: (body: unknown) => T) {
      return privateRequest('/me/foods', parse, undefined, { method: 'POST', body })
    },
  }
}

export type Session = ReturnType<typeof createSession>
