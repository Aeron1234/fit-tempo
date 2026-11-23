import { Router } from 'express'
import sharp from 'sharp'
import { z } from 'zod'
import { foodRecognitionRequestSchema, foodRecognitionOutputSchema } from '@fit-tempo/contracts'

const fixtureId = 'synthetic-rice-bowl' as const
const fixtures = [{ id: fixtureId, label: 'Synthetic rice and vegetables' }]

// Server-owned, fictional illustration. Nothing from the browser enters these bytes.
const riceBowl = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">' +
  '<rect width="160" height="120" fill="#eee8da"/><circle cx="80" cy="60" r="52" fill="#5985a1"/>' +
  '<circle cx="80" cy="60" r="45" fill="#fff3c5"/><path d="M80 15a45 45 0 0 1 0 90z" fill="#60834d"/>' +
  '<path d="M86 37l15 2-2 11-16-2zM102 57l15 1-2 12-15-2zM84 69l13-4 3 11-12 5z" fill="#f39641"/>' +
  '<path d="M52 38l8 3m-15 9l8-3m8 11l8 4m-29 0l8 2m6 17l9 4m6-17l8 2" stroke="#d9c27f" stroke-width="3"/>' +
  '</svg>',
)

type Fixture = Readonly<{ id: typeof fixtureId; image: Buffer; mimeType: 'image/png' }>
type Recognizer = (fixture: Fixture, signal: AbortSignal) => Promise<unknown>
type Options = {
  mode: 'disabled' | 'synthetic'
  reserve?: (owner: string) => Promise<boolean>
  recognize?: Recognizer
  deadlineMs?: number
}

async function approvedFixture(): Promise<Fixture> {
  return { id: fixtureId, image: await sharp(riceBowl).png().toBuffer(), mimeType: 'image/png' }
}

const localRecognition: Recognizer = async ({ image }) => {
  const { format, width, height } = await sharp(image).metadata()
  if (format !== 'png' || width !== 160 || height !== 120) throw Error('Invalid local fixture')
  return { candidates: [{ name: 'Rice', portionGrams: null }, { name: 'Mixed vegetables', portionGrams: null }] }
}

class RecognizerFailure extends Error {
  constructor(readonly kind: 'quota' | 'invalid') { super('Food recognition failed') }
}

async function beforeDeadline<T>(milliseconds: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Error('Food recognition deadline'))
        }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function createFoodRecognitionRouter({ mode, reserve, recognize = localRecognition, deadlineMs = 8000 }: Options) {
  const router = Router()
  router.get('/ai/food-suggestions', (_request, response) => {
    const enabled = mode === 'synthetic' && reserve !== undefined
    response.json({ data: { enabled, fixtures: enabled ? fixtures : [] } })
  })
  router.get('/ai/food-suggestions/fixtures/:fixtureId', async (request, response) => {
    if (mode !== 'synthetic' || !reserve || request.params.fixtureId !== fixtureId) {
      return response.status(404).json({ error: {
        code: 'NOT_FOUND', message: 'This synthetic image is unavailable.', requestId: response.locals.requestId,
      } })
    }
    const fixture = await approvedFixture()
    return response.set('Cache-Control', 'private, no-store').type(fixture.mimeType).send(fixture.image)
  })

  router.post('/ai/food-suggestions', async (request, response) => {
    const fail = (status: number, code: string, message: string) =>
      response.status(status).json({ error: { code, message, requestId: response.locals.requestId } })
    const limited = () => fail(429, 'RATE_LIMITED', 'Food recognition quota reached. You can still log meals manually.')
    if (mode !== 'synthetic') return fail(503, 'DEPENDENCY_UNAVAILABLE', 'Food recognition is unavailable. You can still log meals manually.')
    if (!request.is('application/json') || !foodRecognitionRequestSchema.safeParse(request.body).success) {
      return fail(400, 'VALIDATION_ERROR', 'Select an approved synthetic food image. Uploads are unavailable.')
    }
    try {
      if (!reserve) throw Error('Recognition quota unavailable')
      if (!await beforeDeadline(Math.min(deadlineMs, 2000), () => reserve(response.locals.userId))) return limited()
      const raw = await beforeDeadline(deadlineMs, async signal => {
        const fixture = await approvedFixture()
        signal.throwIfAborted()
        return recognize(fixture, signal)
      })
      const parsed = foodRecognitionOutputSchema.safeParse(raw)
      if (!parsed.success) throw new RecognizerFailure('invalid')
      return response.json({ data: { fixtureId, ...parsed.data } })
    } catch (error) {
      if (error instanceof RecognizerFailure) {
        if (error.kind === 'quota') return limited()
        return fail(503, 'DEPENDENCY_UNAVAILABLE', 'Food recognition returned an unusable suggestion. You can still log meals manually.')
      }
      return fail(503, 'DEPENDENCY_UNAVAILABLE', 'Food recognition is unavailable. You can still log meals manually.')
    }
  })
  return router
}

const groqResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.literal('stop'),
    message: z.object({ content: z.string() }),
  })).length(1),
})

async function readProviderResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new RecognizerFailure('invalid')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 64 * 1024) {
        await reader.cancel()
        throw new RecognizerFailure('invalid')
      }
      body += decoder.decode(value, { stream: true })
    }
    return JSON.parse(body + decoder.decode()) as unknown
  } catch {
    throw new RecognizerFailure('invalid')
  } finally {
    reader.releaseLock()
  }
}

export function createGroqFoodRecognizer({ apiKey, model, transport = fetch }: {
  apiKey: string; model: string; transport?: typeof fetch
}): Recognizer {
  return async (fixture, signal) => {
    const response = await transport('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'List at most eight visible foods in this synthetic illustration by short name. There is no scale, so portionGrams must be null. Do not infer nutrients. Return a JSON object with a candidates array of objects containing name and portionGrams.' },
          { type: 'image_url', image_url: { url: `data:${fixture.mimeType};base64,${fixture.image.toString('base64')}` } },
        ] }],
        max_completion_tokens: 512,
        response_format: { type: 'json_object' },
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429) throw new RecognizerFailure('quota')
      throw Error('Food recognition provider unavailable')
    }
    const envelope = groqResponseSchema.safeParse(await readProviderResponse(response))
    if (!envelope.success) throw new RecognizerFailure('invalid')
    try {
      const data = foodRecognitionOutputSchema.parse(JSON.parse(envelope.data.choices[0]!.message.content))
      if (data.candidates.some(candidate => candidate.portionGrams !== null)) throw Error('Unmeasurable portion')
      return data
    } catch {
      throw new RecognizerFailure('invalid')
    }
  }
}
