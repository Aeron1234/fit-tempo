import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AdminPage } from '../src/pages/Admin.tsx'

test('administration keeps account data scoped and only offers status actions for trainees', () => {
  const client = new QueryClient()
  let snapshot = { status: 'authenticated', user: { id: 'fixture-admin', role: 'admin' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  client.setQueryData(['private', 'fixture-admin', 'admin', 'users', 0], { data: [
    { id: '201db73d-ae8a-44e5-a2fd-e4c97ca32d32', email: 'fixture-admin@example.invalid', role: 'admin', active: true },
    { id: '1701bead-8e33-4715-989f-2338968c01fa', email: 'fixture-trainee@example.invalid', role: 'trainee', active: true },
  ] })
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(AdminPage, { session })))
  try {
    const served = render()
    for (const label of ['Administration', 'Shared foods', 'Shared exercises', 'Categories', 'Audit history', 'Statistics']) {
      assert.ok(served.includes(label), label)
    }
    assert.doesNotMatch(served.match(/<tr>.*?fixture-admin@example.invalid.*?<\/tr>/)?.[0] ?? '', /Suspend/)
    assert.match(served.match(/<tr><td>fixture-trainee@example.invalid.*?<\/tr>/)?.[0] ?? '', />Suspend<\/button>/)
    snapshot = { status: 'authenticated', user: { id: 'fixture-admin', role: 'trainee' } }
    assert.match(render(), /Administrator access is required/)
    assert.doesNotMatch(render(), /fixture-trainee@example.invalid/)
    snapshot = { status: 'authenticated', user: { id: 'other-admin', role: 'admin' } }
    assert.doesNotMatch(render(), /fixture-trainee@example.invalid/)
    snapshot = { status: 'anonymous' }
    assert.equal(render(), '')
  } finally {
    client.clear()
  }
})
