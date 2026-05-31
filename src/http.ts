type FetchHtmlOptions = {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
}

type FetchAttemptLog = {
  url: string
  status?: number
  attempt: number
  maxAttempts: number
  retryDelayMs?: number
  reason: string
}

export class FetchHtmlError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'FetchHtmlError'
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const numeric = Number.parseInt(value, 10)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1000

  const retryAt = Date.parse(value)
  if (!Number.isNaN(retryAt)) {
    const delta = retryAt - Date.now()
    return delta > 0 ? delta : 0
  }

  return null
}

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, attempt - 1)
  const expDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent))
  const jitterRange = Math.max(1, Math.floor(expDelay * 0.2))
  const jitter = Math.floor(Math.random() * jitterRange)
  return Math.min(maxDelayMs, expDelay + jitter)
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function fetchHtmlWithRetry(
  url: string,
  sleep: (ms: number) => Promise<void>,
  options: FetchHtmlOptions = {},
  onRetry?: (log: FetchAttemptLog) => void
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 8000
  const timeoutMs = options.timeoutMs ?? 10_000

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let currentUrl = url
      const cookieJar = new Map<string, string>()
      let redirectCount = 0
      const maxRedirects = 10
      let res: Response | null = null

      while (true) {
        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 ArabFreelanceJobsBot/2.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }

        if (cookieJar.size > 0) {
          headers['Cookie'] = Array.from(cookieJar.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ')
        }

        res = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers
        })

        const setCookies = res.headers.getSetCookie()
        if (setCookies && setCookies.length > 0) {
          for (const header of setCookies) {
            const parts = header.split(';')
            const firstPart = parts[0]?.trim()
            if (firstPart) {
              const eqIdx = firstPart.indexOf('=')
              if (eqIdx !== -1) {
                const key = firstPart.slice(0, eqIdx).trim()
                const val = firstPart.slice(eqIdx + 1).trim()
                if (key) {
                  cookieJar.set(key, val)
                }
              }
            }
          }
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location')
          if (location) {
            if (redirectCount >= maxRedirects) {
              throw new FetchHtmlError(`Fetch failed for ${url}: Redirect loop detected or max redirects exceeded`, url, res.status)
            }
            currentUrl = new URL(location, currentUrl).href
            redirectCount += 1
            continue
          }
        }

        break
      }

      if (res.ok) return res.text()

      const status = res.status
      const retriable = shouldRetryStatus(status) && attempt < maxAttempts
      if (!retriable) {
        throw new FetchHtmlError(`Fetch failed for ${url}: ${status}`, url, status)
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      const retryDelayMs = retryAfterMs ?? backoffDelayMs(attempt, baseDelayMs, maxDelayMs)
      onRetry?.({
        url,
        status,
        attempt,
        maxAttempts,
        retryDelayMs,
        reason: status === 429 ? 'rate-limited' : 'upstream-server-error'
      })
      await sleep(retryDelayMs)
      continue
    } catch (error) {
      lastError = error
      const retriableError = isAbortError(error) || error instanceof TypeError
      const canRetry = retriableError && attempt < maxAttempts
      if (!canRetry) {
        if (error instanceof FetchHtmlError) throw error
        if (isAbortError(error)) throw new FetchHtmlError(`Fetch timeout for ${url}`, url)
        throw new FetchHtmlError(`Fetch failed for ${url}: ${String(error)}`, url)
      }

      const retryDelayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs)
      onRetry?.({
        url,
        attempt,
        maxAttempts,
        retryDelayMs,
        reason: isAbortError(error) ? 'timeout' : 'network-error'
      })
      await sleep(retryDelayMs)
    } finally {
      clearTimeout(timer)
    }
  }

  if (lastError instanceof FetchHtmlError) throw lastError
  throw new FetchHtmlError(`Fetch failed for ${url}: retry budget exhausted`, url)
}
