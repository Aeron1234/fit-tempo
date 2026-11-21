import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import sharp from 'sharp'
import { foodRecognitionResponseSchema } from '@fit-tempo/contracts'
import { createFoodRecognitionRouter, createGeminiFoodRecognizer } from '../dist/food-recognition.js'

const path = '/ai/food-suggestions'
const fixtureId = 'synthetic-rice-bowl'

async function serve(options, check) {
  const app = express()
  app.use(express.json({ limit: '8kb' }))
  app.use((_req, res, next) => {
    res.locals.userId = 'fictional-owner'
    res.locals.requestId = '4c2db46f-0076-4cee-aaeb-b53da6a70931'
    next()
  })
  app.use(createFoodRecognitionRouter(options))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = 'http://127.0.0.1:' + server.address().port + path
  try {
    await check({
      get: () => fetch(url),
      preview: name => fetch(url + '/fixtures/' + name),
      post: (body, type = 'application/json') => fetch(url, {
        method: 'POST', headers: { 'Content-Type': type },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    })
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('food recognition accepts only the approved synthetic PNG and keeps unknown portions', async () => {
  let calls = 0
  let reservations = 0
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  await serve({
    mode: 'synthetic',
    reserve: async owner => { assert.equal(owner, 'fictional-owner'); reservations++; return true },
    recognize: async fixture => {
      calls++
      assert.equal(fixture.id, fixtureId)
      assert.equal(fixture.mimeType, 'image/png')
      assert.deepEqual(fixture.image.subarray(0, png.length), png)
      const meta = await sharp(fixture.image).metadata()
      assert.equal(meta.width, 160)
      assert.equal(meta.height, 120)
      return { candidates: [{ name: 'Rice', portionGrams: null }] }
    },
  }, async ({ get, post, preview }) => {
    assert.deepEqual((await (await get()).json()).data.fixtures.map(fixture => fixture.id), [fixtureId])
    assert.equal((await preview('unapproved-image')).status, 404)
    const picture = await preview(fixtureId)
    assert.equal(picture.status, 200)
    assert.match(picture.headers.get('content-type'), /^image\/png/)
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()).subarray(0, png.length), png)
    for (const [body, type] of [
      [{ fixtureId: 'unapproved-image' }],
      [{ fixtureId, upload: 'not-allowed' }],
      [{ fixtureId, url: 'https://example.invalid/personal.jpg' }],
      [{ fixtureId, imageBase64: 'abcd' }],
      ['upload', 'application/octet-stream'],
      ['upload', 'multipart/form-data; boundary=receipt'],
    ]) assert.equal((await post(body, type)).status, 400)
    assert.equal(calls, 0)
    assert.equal(reservations, 0)
    const response = await post({ fixtureId })
    assert.equal(response.status, 200)
    assert.deepEqual(foodRecognitionResponseSchema.parse(await response.json()).data, {
      fixtureId, candidates: [{ name: 'Rice', portionGrams: null }],
    })
    assert.equal(calls, 1)
    assert.equal(reservations, 1)
  })
  await serve({ mode: 'synthetic', reserve: async () => true }, async ({ post }) => {
    const response = await post({ fixtureId })
    assert.equal(response.status, 200)
    assert.ok(foodRecognitionResponseSchema.parse(await response.json()).data.candidates.every(item => item.portionGrams === null))
  })
})

test('food recognition exercises disabled, quota, deadline and malformed suggestion fallbacks', async t => {
  const cases = [
    ['disabled', { mode: 'disabled', reserve: async () => { throw Error('unexpected reservation') } }, 503],
    ['quota', { mode: 'synthetic', reserve: async () => false }, 429],
    ['quota unavailable', { mode: 'synthetic', reserve: async () => { throw Error('internal redis fault') } }, 503],
    ['missing reservation', { mode: 'synthetic' }, 503],
  ]
  for (const [name, options, status] of cases) await t.test(name, async () => {
    let invoked = false
    await serve({ ...options, recognize: async () => { invoked = true } }, async ({ post }) => {
      const response = await post({ fixtureId })
      assert.equal(response.status, status)
      assert.equal((await response.json()).error.code, status === 429 ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE')
      assert.equal(invoked, false)
    })
  })
  await t.test('malformed output', async () => {
    await serve({ mode: 'synthetic', reserve: async () => true, recognize: async () => ({
      candidates: [{ name: 'Rice', portionGrams: 'not a number', kcal: 'untrusted' }],
    }) }, async ({ post }) => {
      const response = await post({ fixtureId })
      assert.equal(response.status, 503)
      assert.match((await response.json()).error.message, /unusable suggestion/)
    })
  })
  await t.test('deadline aborts recognizer', async () => {
    let aborted = false
    await serve({
      mode: 'synthetic', reserve: async () => true, deadlineMs: 200,
      recognize: async (_fixture, signal) => new Promise(resolve => {
        signal.addEventListener('abort', () => { aborted = true; resolve({}) }, { once: true })
      }),
    }, async ({ post }) => {
      const response = await post({ fixtureId })
      assert.equal(response.status, 503)
      assert.equal(aborted, true)
    })
  })
})

test('Gemini adapter validates the structured response and sends only fixture bytes with static instructions', async () => {
  const fixture = { id: fixtureId, image: Buffer.from('fictional-fixture'), mimeType: 'image/png' }
  const envelope = raw => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: raw }] } }] })
  const candidate = { candidates: [{ name: 'Rice', portionGrams: null }] }
  const replies = [
    Response.json(envelope(JSON.stringify(candidate))),
    Response.json(envelope('broken json')),
    Response.json(envelope(JSON.stringify({ candidates: [{ name: 'Rice', portionGrams: '12' }] }))),
    Response.json({ candidates: [] }),
    new Response('', { status: 429 }),
  ]
  const ai = createGeminiFoodRecognizer({
    apiKey: 'synthetic-fake-key', model: 'synthetic-test-model',
    transport: async (url, init) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/synthetic-test-model:generateContent')
      assert.equal(init.headers['x-goog-api-key'], 'synthetic-fake-key')
      assert.equal(init.redirect, 'error')
      const body = JSON.parse(init.body)
      assert.equal(body.generationConfig.responseMimeType, 'application/json')
      assert.deepEqual(body.contents[0].parts[1], {
        inlineData: { mimeType: 'image/png', data: fixture.image.toString('base64') },
      })
      return replies.shift()
    },
  })
  const signal = new AbortController().signal
  assert.deepEqual(await ai(fixture, signal), candidate)
  for (let index = 0; index < 3; index++) await assert.rejects(ai(fixture, signal), { kind: 'invalid' })
  await assert.rejects(ai(fixture, signal), { kind: 'quota' })
  assert.equal(replies.length, 0)
})
