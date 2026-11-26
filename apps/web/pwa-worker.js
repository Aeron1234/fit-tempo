/* global self, caches, ASSETS, CACHE, Request, URL, fetch */
const prefix = 'fit-tempo-shell-'

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(
    ['/index.html', ...ASSETS].map(url => new Request(url, {
      cache: 'reload', credentials: 'omit', redirect: 'error',
    })),
  )))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(prefix) && key !== CACHE).map(key => caches.delete(key)),
  )))
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/api(?:\/|$)/i.test(url.pathname)) return

  if (request.mode === 'navigate' && !/\.[^/]+$/.test(url.pathname) && !url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      await cache.match('/index.html') || fetch(request)))
  } else if (!url.search && ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      await cache.match(request) || fetch(request)))
  }
})

