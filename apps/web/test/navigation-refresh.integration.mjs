import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AppNavigation } from '../src/components/shared/AppNavigation.tsx'

function render(path, admin = false) {
  return renderToString(h(MemoryRouter, { initialEntries: [path] },
    h(AppNavigation, { admin, brand: 'Fit Tempo', onSignOut() {}, signingOut: false }),
  ))
}

test('mobile navigation has four primary links and marks More current for a secondary route', () => {
  const html = render('/app/week')
  const mobile = html.match(/<nav[^>]*tempo-mobile-nav[^>]*>(.*?)<\/nav>/s)?.[1]
  assert.ok(mobile)
  assert.deepEqual([...mobile.matchAll(/href="([^"]+)"/g)].map(match => match[1]),
    ['/app', '/app/meals', '/app/workouts', '/app/foods'])
  assert.match(mobile, /<button[^>]*aria-haspopup="dialog"[^>]*aria-controls="app-more-sheet"[^>]*aria-current="page"/)
  const sheet = html.match(/<dialog[^>]*aria-labelledby="app-more-heading"[^>]*>(.*?)<\/dialog>/s)?.[1]
  assert.ok(sheet)
  assert.match(sheet, /aria-current="page"[^>]*href="\/app\/week"/)
  assert.match(sheet, /aria-label="Sign out"/)
  assert.doesNotMatch(mobile, /aria-label="Sign out"/)
})

test('admin mobile navigation promotes Settings and retains Workouts in More', () => {
  const html = render('/app/profile', true)
  const mobile = html.match(/<nav[^>]*tempo-mobile-nav[^>]*>(.*?)<\/nav>/s)?.[1]
  assert.ok(mobile)
  assert.deepEqual([...mobile.matchAll(/href="([^"]+)"/g)].map(match => match[1]),
    ['/app', '/app/meals', '/app/foods', '/app/profile'])
  assert.match(mobile, /aria-current="page"[^>]*href="\/app\/profile"/)
  assert.match(html, /<dialog[^>]*>.*href="\/app\/workouts"/s)
})

test('both desktop rails keep Sign out after the scrollable navigation', () => {
  for (const admin of [false, true]) {
    const rail = render('/app', admin).match(/<aside[^>]*>(.*?)<\/aside>/s)?.[1]
    assert.ok(rail)
    assert.doesNotMatch(rail.match(/<header[^>]*>(.*?)<\/header>/s)?.[1] ?? '', /Sign out/)
    assert.match(rail, /<nav[^>]*overflow-y-auto[^>]*>.*<\/nav><footer[^>]*tempo-rail-footer.*<button[^>]*aria-label="Sign out" title="Sign out"/s)
  }
})
