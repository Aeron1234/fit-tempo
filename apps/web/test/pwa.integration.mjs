/* global URL, Request */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const origin = 'https://fit-tempo.example'
const root = new URL('../', import.meta.url)

test('worker precaches anonymous shell and serves only shell navigations and build assets', async () => {
  const listeners = new Map()
  const precached = []
  const cache = { addAll: urls => precached.push(...urls), match: async key => key }
  const source = readFileSync(new URL('pwa-worker.js', root), 'utf8')
  runInNewContext(source, {
    self: { location: { origin }, addEventListener: (name, listener) => listeners.set(name, listener) },
    caches: { open: async () => cache },
    CACHE: 'fit-tempo-shell-fixture',
    ASSETS: ['/assets/index-fixture.js'],
    Request: class extends Request {
      constructor(url, options) { super(origin + url, options) }
    },
    URL,
  })
  let installed
  listeners.get('install')({ waitUntil: work => { installed = work } })
  await installed
  assert.deepEqual(precached.map(request => [request.url, request.credentials]), [
    [origin + '/index.html', 'omit'], [origin + '/assets/index-fixture.js', 'omit'],
  ])
  function request(url, mode = 'cors', method = 'GET') {
    let response
    listeners.get('fetch')({
      request: { url: new URL(url, origin).href, mode, method },
      respondWith: work => { response = work },
    })
    return response
  }
  assert.equal(await request('/app/meals?date=2026-11-27', 'navigate'), '/index.html')
  assert.equal(await request('/reset-password?token=example', 'navigate'), '/index.html')
  assert.ok(await request('/assets/index-fixture.js'))
  for (const url of ['/api/v1/auth/me', '/api/v1/me', '/assets/not-in-build.js', 'https://other.example/']) {
    assert.equal(request(url, 'navigate'), undefined)
  }
  assert.equal(request('/api/v1/me/meals', 'cors', 'POST'), undefined)
  assert.equal(request('/assets/index-fixture.js?unexpected'), undefined)
})

test('manifest uses standalone launch and valid icon dimensions', () => {
  const manifest = JSON.parse(readFileSync(new URL('public/manifest.webmanifest', root), 'utf8'))
  assert.equal(manifest.start_url, '/app')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'))
  for (const { src, sizes } of manifest.icons) {
    const png = readFileSync(new URL('public' + src, root))
    assert.equal(png.toString('ascii', 12, 16), 'IHDR')
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, sizes)
  }
})
