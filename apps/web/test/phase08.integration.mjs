/* global fetch, navigator, Response */
import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createSession } from '../src/lib/api/session.ts'
import { ForgotPasswordPage, ProtectedLayout, RegisterPage, ResendVerificationPage, ResetPasswordPage, SignInPage, VerifyEmailPage } from '../src/pages/Phase08.tsx'
import { RouteErrorPage } from '../src/pages/RouteErrorPage.tsx'

const deferred = () => Promise.withResolvers()
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})

test('verification landing requires a usable link and an explicit confirmation', () => {
  const session = { verifyEmail: () => assert.fail('Rendering must never submit a verification token') }
  const render = (path) => renderToString(h(MemoryRouter, { initialEntries: [path] }, h(VerifyEmailPage, { session })))
  const missing = render('/verify-email')
  assert.match(missing, /class="tempo-canvas account-layout"/)
  assert.match(missing, /href="\/resend-verification"[^>]*>Request a new link/)
  assert.doesNotMatch(missing, />Verify email<\/button>/)
  const token = 'v'.repeat(40)
  const linked = render(`/verify-email?token=${token}`)
  assert.match(linked, />Verify email<\/button>/)
  assert.ok(!linked.includes(token))
})

test('verification resend uses the shared account layout with an email-only form', () => {
  const snapshot = { status: 'anonymous' }
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  const html = renderToString(h(MemoryRouter, null, h(ResendVerificationPage, { session })))
  assert.match(html, /class="tempo-canvas account-layout"/)
  assert.match(html, /autocomplete="email"/i)
  assert.match(html, /role="status"/)
  assert.match(html, /type="submit">Send verification link/)
  assert.doesNotMatch(html, /type="password"/)
})

test('account routes render branded forms and a shortcut past the feature carousel', () => {
  const snapshot = { status: 'anonymous' }
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  for (const [path, Page, heading, passwordHint, switchPath] of [
    ['/sign-in', SignInPage, 'Sign in', 'current-password', '/register'],
    ['/register', RegisterPage, 'Create your account', 'new-password', '/sign-in'],
  ]) {
    const html = renderToString(h(MemoryRouter, { initialEntries: [path] },
      h(Routes, null, h(Route, { path, element: h(Page, { session }) })),
    ))
    assert.match(html, new RegExp(`id="account-heading"[^>]*>${heading}</h1>`))
    assert.match(html, /src="\/fit-tempo-mark.png"/)
    assert.match(html, /for="account-email">Email address/)
    assert.match(html, /autocomplete="username"/i)
    assert.match(html, new RegExp(`autocomplete="${passwordHint}"`, 'i'))
    assert.ok(html.includes(`href="${switchPath}"`))
    assert.match(html, /aria-label="Previous feature"/)
    assert.match(html, /aria-label="Next feature"/)
    assert.match(html, /aria-label="Pause slideshow"/)
    for (const photo of ['pantry', 'runner', 'tracking']) {
      assert.ok(html.includes(`src="/account-${photo}.jpg"`))
    }
    assert.match(html, /data-active="true" src="\/account-pantry.jpg"/)
    assert.match(html, /href="#account-heading".*aria-roledescription="carousel".*<form/)
    if (path === '/sign-in') {
      assert.match(html, /id="account-password".*href="\/forgot-password".*type="submit"/)
      assert.match(html, /href="\/resend-verification"/)
    }
  }
})

function whenSession(session, predicate) {
  if (predicate(session.getSnapshot())) return Promise.resolve()
  return new Promise(resolve => {
    const unsubscribe = session.subscribe(() => {
      if (!predicate(session.getSnapshot())) return
      unsubscribe()
      resolve()
    })
  })
}

test('cold load, cross-tab refresh, sign-out and account switching isolate private caches', { timeout: 10000 }, async () => {
  const originalFetch = fetch
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let tail = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request(_name, options, callback) {
      const run = tail.then(typeof options === 'function' ? options : callback)
      tail = run.catch(() => {})
      return run
    },
  } })

  const refresh = deferred()
  const enteredRefresh = deferred()
  let signedIn = true
  let accessValid = false
  let refreshCount = 0
  let lostRefreshResponse = false
  let account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const secondAccount = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  globalThis.fetch = async (input, options) => {
    assert.equal(options.credentials, 'include')
    const path = String(input).split('/auth/')[1]
    if (path === 'csrf') return json({ data: { csrfToken: 'csrf-fixture' } })
    if (path === 'me') return signedIn && accessValid
      ? json({ data: { id: account, role: 'trainee' } })
      : json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401)
    if (path === 'refresh') {
      refreshCount += 1
      enteredRefresh.resolve()
      await refresh.promise
      if (!signedIn) return json({}, 401)
      accessValid = true
      if (lostRefreshResponse) throw new TypeError('Simulated lost refresh response')
      return json({ data: { authenticated: true } })
    }
    if (path === 'logout') {
      signedIn = false
      accessValid = false
      return json({ data: { accepted: true } })
    }
    if (path === 'login') {
      account = secondAccount
      signedIn = accessValid = true
      return json({ data: { authenticated: true } })
    }
    throw new Error('Unexpected API request')
  }
  const firstCache = new QueryClient()
  const secondCache = new QueryClient()
  const first = createSession(firstCache)
  const second = createSession(secondCache)
  try {
    const pending = [first.initialize(), second.initialize()]
    await enteredRefresh.promise
    assert.equal(first.getSnapshot().status, 'checking')
    assert.equal(second.getSnapshot().status, 'checking')
    refresh.resolve()
    await Promise.all(pending)
    assert.equal(refreshCount, 1)
    assert.equal(first.getSnapshot().user.id, account)
    assert.equal(second.getSnapshot().user.id, account)

    const privateKey = ['private', account, 'profile']
    firstCache.setQueryData(privateKey, 'first account fixture')
    secondCache.setQueryData(privateKey, 'first account fixture')
    let cancelled = false
    const pendingQuery = firstCache.fetchQuery({
      queryKey: ['private', account, 'pending'],
      queryFn: ({ signal }) => new Promise(resolve => {
        signal.addEventListener('abort', () => { cancelled = true; resolve('late fixture') }, { once: true })
      }),
    }).catch(() => {})
    await first.signOut()
    assert.equal(first.getSnapshot().status, 'anonymous')
    assert.equal(firstCache.getQueryData(privateKey), undefined)
    await pendingQuery
    assert.equal(cancelled, true)
    await whenSession(second, snapshot => snapshot.status === 'anonymous')
    assert.equal(second.getSnapshot().status, 'anonymous')
    assert.equal(secondCache.getQueryData(privateKey), undefined)
    await first.signIn('second@example.invalid', 'synthetic-password')
    assert.equal(first.getSnapshot().user.id, secondAccount)
    assert.equal(firstCache.getQueryData(privateKey), undefined)
    await whenSession(second, snapshot => snapshot.status === 'authenticated' && snapshot.user.id === secondAccount)
    assert.equal(secondCache.getQueryData(privateKey), undefined)

    accessValid = false
    lostRefreshResponse = true
    const countBeforeLoss = refreshCount
    await Promise.all([first.initialize(), second.initialize()])
    assert.equal(refreshCount - countBeforeLoss, 1)
    assert.equal(first.getSnapshot().user.id, secondAccount)
    assert.equal(second.getSnapshot().user.id, secondAccount)
  } finally {
    refresh.resolve()
    first.dispose?.()
    second.dispose?.()
    firstCache.clear()
    secondCache.clear()
    globalThis.fetch = originalFetch
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else delete navigator.locks
  }
})

test('protected layout withholds private content until a session is confirmed', () => {
  const render = snapshot => {
    const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
    return renderToString(h(MemoryRouter, { initialEntries: ['/app'] },
      h(Routes, null, h(Route, { element: h(ProtectedLayout, { session }) },
        h(Route, { path: '/app', element: h('p', null, 'Private fixture content') }),
      )),
    ))
  }
  for (const status of ['checking', 'anonymous', 'error']) {
    assert.doesNotMatch(render({ status }), /Private fixture content/)
  }
  const pending = render({ status: 'checking' })
  const failure = render({ status: 'error' })
  assert.match(pending, /role="status".*Loading Fit Tempo/)
  assert.match(pending, /motion-safe:animate-spin/)
  assert.match(failure, />Try again<\/button>/)
  assert.match(failure, /href="\/sign-in"/)
  assert.doesNotMatch(pending + failure, /Preview a sample day/)
  assert.match(render({ status: 'authenticated', user: { id: 'owner', role: 'trainee' } }),
    /Private fixture content/)
})

test('recovery routes provide the appropriate next action', () => {
  const snapshot = { status: 'anonymous' }
  const session = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  const render = (Page, props, path) => renderToString(h(MemoryRouter, { initialEntries: [path] }, h(Page, props)))
  assert.match(render(ForgotPasswordPage, { session }, '/forgot-password'), /account-layout.*Send reset link/)
  assert.match(render(ResetPasswordPage, { session }, '/reset-password'), /Reset link needed.*href="\/forgot-password"/)
  assert.match(render(ResetPasswordPage, { session }, `/reset-password?token=${'r'.repeat(40)}`), /account-layout.*Update password/)
  assert.match(render(RouteErrorPage, { notFound: true }, '/missing'), /Page not found.*Return to Fit Tempo/)
  assert.match(render(RouteErrorPage, {}, '/app'), /Reload page.*Return to Fit Tempo/)
})
