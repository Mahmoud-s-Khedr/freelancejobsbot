import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchHtmlWithRetry, FetchHtmlError } from '../src/http.js'

function makeResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

test('fetchHtmlWithRetry retries on 429 and then succeeds', async () => {
  const calls: number[] = []
  const delays: number[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    calls.push(1)
    if (calls.length < 3) return makeResponse(429, 'rate limited', { 'retry-after': '0' })
    return makeResponse(200, '<html>ok</html>')
  }) as typeof fetch

  try {
    const html = await fetchHtmlWithRetry(
      'https://example.com',
      async ms => { delays.push(ms) },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000 }
    )
    assert.equal(html, '<html>ok</html>')
    assert.equal(calls.length, 3)
    assert.equal(delays.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchHtmlWithRetry stops after retry budget on 5xx', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => makeResponse(504, 'bad gateway')) as typeof fetch

  try {
    await assert.rejects(
      fetchHtmlWithRetry('https://example.com', async () => {}, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        timeoutMs: 1000
      }),
      (error: unknown) => {
        assert.ok(error instanceof FetchHtmlError)
        assert.equal(error.status, 504)
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchHtmlWithRetry honors Retry-After delay', async () => {
  const delays: number[] = []
  const originalFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = (async () => {
    called += 1
    if (called === 1) return makeResponse(429, 'rate limited', { 'retry-after': '2' })
    return makeResponse(200, '<html>ok</html>')
  }) as typeof fetch

  try {
    await fetchHtmlWithRetry(
      'https://example.com',
      async ms => { delays.push(ms) },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000 }
    )
    assert.equal(delays[0], 2000)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchHtmlWithRetry retries timeout errors and then succeeds', async () => {
  const originalFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    called += 1
    if (called === 1) {
      const signal = init?.signal
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    return makeResponse(200, '<html>ok</html>')
  }) as typeof fetch

  try {
    const html = await fetchHtmlWithRetry(
      'https://example.com',
      async () => {},
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 10 }
    )
    assert.equal(html, '<html>ok</html>')
    assert.equal(called, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchHtmlWithRetry manually follows redirects and propagates cookies', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  
  globalThis.fetch = (async (urlInput: RequestInfo | URL, init?: RequestInit) => {
    const url = String(urlInput)
    calls.push(url)
    const cookies = init?.headers ? (init.headers as Record<string, string>)['Cookie'] : undefined
    
    if (url === 'https://example.com/start') {
      const headers = new Headers()
      headers.append('Location', '/redirect')
      headers.append('Set-Cookie', 'session=123; Path=/')
      headers.append('Set-Cookie', 'lang=en; Path=/')
      return new Response('', { status: 302, headers })
    }
    
    if (url === 'https://example.com/redirect') {
      if (cookies?.includes('session=123') && cookies?.includes('lang=en')) {
        return makeResponse(200, '<html>redirect ok</html>')
      }
      const headers = new Headers()
      headers.append('Location', '/start')
      return new Response('', { status: 302, headers })
    }
    
    return makeResponse(404, 'not found')
  }) as typeof fetch

  try {
    const html = await fetchHtmlWithRetry(
      'https://example.com/start',
      async () => {},
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000 }
    )
    assert.equal(html, '<html>redirect ok</html>')
    assert.deepEqual(calls, [
      'https://example.com/start',
      'https://example.com/redirect'
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchHtmlWithRetry detects and stops redirect loops', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  
  globalThis.fetch = (async () => {
    calls++
    const headers = new Headers()
    headers.append('Location', '/loop')
    return new Response('', { status: 302, headers })
  }) as typeof fetch

  try {
    await assert.rejects(
      fetchHtmlWithRetry('https://example.com/loop', async () => {}, {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 2,
        timeoutMs: 1000
      }),
      (error: unknown) => {
        assert.ok(error instanceof FetchHtmlError)
        assert.ok(String(error).includes('Redirect loop detected or max redirects exceeded'))
        return true
      }
    )
    assert.equal(calls, 11)
  } finally {
    globalThis.fetch = originalFetch
  }
})

