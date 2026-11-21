import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NotificationSettingsPage } from '../src/pages/NotificationSettings.tsx'

const preferences = {
  mode: 'hobby-daily',
  timeZone: 'Asia/Manila',
  globalOptOut: true,
  quietStart: '22:00',
  quietEnd: '06:00',
  revision: 4,
  types: [
    { type: 'workout_reminder', enabled: false, supported: false },
    { type: 'meal_reminder', enabled: true, supported: true },
    { type: 'hydration_reminder', enabled: false, supported: false },
    { type: 'weekly_summary', enabled: true, supported: true },
    { type: 'milestone', enabled: false, supported: true },
    { type: 'inactivity', enabled: false, supported: true },
  ],
  nextSendAt: null,
}

test('email settings label capabilities and preserve optional choices and quiet hours', () => {
  const client = new QueryClient()
  let snapshot = { status: 'authenticated', user: { id: 'owner' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const key = ['private', 'owner', 'notification-preferences']
  client.setQueryData(key, { data: preferences })
  const render = () => renderToStaticMarkup(h(MemoryRouter, null,
    h(QueryClientProvider, { client }, h(NotificationSettingsPage, { session }))))
  try {
    const html = render()
    assert.match(html, /Hobby scheduler · Daily run only/)
    assert.match(html, /No next send is scheduled/)
    assert.match(html, /Verification and password-reset emails remain available/)
    assert.match(html, /Turn off all optional emails/)
    assert.match(html, /individual choices are saved/)
    assert.match(html, /<input(?=[^>]*disabled)(?=[^>]*name="workout_reminder")/)
    assert.match(html, /<input(?=[^>]*disabled)(?=[^>]*name="hydration_reminder")/)
    assert.match(html, /<input(?=[^>]*checked="")(?=[^>]*name="weekly_summary")/)
    assert.match(html, /value="22:00"/)
    assert.match(html, /value="06:00"/)
    assert.match(html, /Asia\/Manila/)
    assert.match(html, /href="\/app\/profile"/)
    client.setQueryData(key, { data: { ...preferences, mode: 'manual-dry-run' } })
    assert.match(render(), /Manual dry run · No scheduled email delivery/)
    snapshot = { status: 'authenticated', user: { id: 'different-account' } }
    assert.doesNotMatch(render(), /Asia\/Manila|22:00|optional choices are saved/)
    snapshot = { status: 'loading' }
    assert.equal(render(), '')
  } finally {
    client.clear()
  }
})
