import test from 'node:test'
import assert from 'node:assert/strict'
import { SOURCES, claimNextTelegramQueueItem, isRetriableSourceError, sendTelegramMessage } from '../src/index.js'
import { FetchHtmlError } from '../src/http.js'
import { prisma } from '../src/db.js'

test('SOURCES excludes bahr', () => {
  const names = SOURCES.map(source => source.name as string)
  assert.equal(names.includes('bahr'), false)
})

test('isRetriableSourceError handles FetchHtmlError and generic status errors', () => {
  assert.equal(isRetriableSourceError(new FetchHtmlError('x', 'https://x', 429)), true)
  assert.equal(isRetriableSourceError(new FetchHtmlError('x', 'https://x', 503)), true)
  assert.equal(isRetriableSourceError(new FetchHtmlError('x', 'https://x', 404)), false)
  assert.equal(isRetriableSourceError(new Error('Ureed GraphQL returned status 500')), true)
  assert.equal(isRetriableSourceError(new Error('Ureed GraphQL returned status 401')), false)
})

test('sendTelegramMessage retries network failures and succeeds', async () => {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN
  const oldChat = process.env.TELEGRAM_CHAT_ID
  const oldMinDelay = process.env.TELEGRAM_MIN_DELAY_MS
  const oldMaxAttempts = process.env.TELEGRAM_MAX_ATTEMPTS
  const oldTimeout = process.env.TELEGRAM_REQUEST_TIMEOUT_MS
  const originalFetch = globalThis.fetch
  let calls = 0

  process.env.TELEGRAM_BOT_TOKEN = 'token'
  process.env.TELEGRAM_CHAT_ID = 'chat'
  process.env.TELEGRAM_MIN_DELAY_MS = '1'
  process.env.TELEGRAM_MAX_ATTEMPTS = '2'
  process.env.TELEGRAM_REQUEST_TIMEOUT_MS = '25'

  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) throw new TypeError('network failure')
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  try {
    await sendTelegramMessage('hello')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = oldToken
    if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID
    else process.env.TELEGRAM_CHAT_ID = oldChat
    if (oldMinDelay === undefined) delete process.env.TELEGRAM_MIN_DELAY_MS
    else process.env.TELEGRAM_MIN_DELAY_MS = oldMinDelay
    if (oldMaxAttempts === undefined) delete process.env.TELEGRAM_MAX_ATTEMPTS
    else process.env.TELEGRAM_MAX_ATTEMPTS = oldMaxAttempts
    if (oldTimeout === undefined) delete process.env.TELEGRAM_REQUEST_TIMEOUT_MS
    else process.env.TELEGRAM_REQUEST_TIMEOUT_MS = oldTimeout
  }
})

test('claimNextTelegramQueueItem uses atomic claim semantics', async () => {
  const originalTx = prisma.$transaction.bind(prisma)
  let claimUsed = false
  const candidate = {
    id: 10,
    attempts: 0,
    failedAt: null,
    jobPost: {
      id: 11,
      source: 'mostaql',
      sourceProjectId: '123',
      title: 'title',
      url: 'https://mostaql.com/project/123',
      description: null,
      rawText: null,
      category: null,
      status: null,
      publishedAt: null,
      budgetMin: null,
      budgetMax: null,
      budgetText: null,
      durationText: null,
      skills: null
    }
  }

  ;(prisma.$transaction as unknown as (fn: (tx: any) => Promise<any>) => Promise<any>) = async fn => fn({
    telegramQueue: {
      updateMany: async ({ where }: any) => {
        if (where?.attempts?.gte !== undefined) return { count: 0 }
        if (!claimUsed) {
          claimUsed = true
          return { count: 1 }
        }
        return { count: 0 }
      },
      findFirst: async () => candidate
    }
  })

  try {
    const [first, second] = await Promise.all([
      claimNextTelegramQueueItem(5),
      claimNextTelegramQueueItem(5)
    ])
    assert.ok(first || second)
    assert.ok((first && !second) || (!first && second))
  } finally {
    ;(prisma.$transaction as unknown as typeof prisma.$transaction) = originalTx
  }
})
