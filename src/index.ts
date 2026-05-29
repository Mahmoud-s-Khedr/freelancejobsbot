import 'dotenv/config'
import * as cheerio from 'cheerio'
import cron from 'node-cron'
import { createHash } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Prisma } from './generated/prisma/client.js'
import { prisma } from './db.js'
import { normalizeUrl, parseMostaqlListing, parseMostaqlProjectDetail } from './mostaql.js'
import { buildKhamsatPageUrl, parseKhamsatDetail, parseKhamsatListing } from './khamsat.js'
import { scrapeUreedSource } from './ureed.js'
import { scrapeBaaeedSource } from './baaeed.js'
import { scrapeNafezlySource } from './nafezly.js'
import { scrapeBahrSource } from './bahr.js'
import { scrapeForasnaSource } from './forasna.js'
import { scrapeTanqeebSource } from './tanqeeb.js'
import { scrapeBaytSource } from './bayt.js'
import { scrapeWuzzufSource } from './wuzzuf.js'
import { scrapeGoogleJobsSource } from './google_jobs.js'
import { formatTelegramMessage } from './format.js'
import { FetchHtmlError, fetchHtmlWithRetry } from './http.js'
import { isTechJob } from './filter.js'

export type SourceName = 'mostaql' | 'khamsat' | 'ureed' | 'baaeed' | 'nafezly' | 'bahr' | 'forasna' | 'tanqeeb' | 'bayt' | 'wuzzuf' | 'google_jobs'

export type SourceConfig = {
  name: SourceName
  url: string
  baseUrl: string
}

export type JobPostInput = {
  source: SourceName
  sourceProjectId: string
  title: string
  url: string
  description?: string
  rawText?: string
  category?: string
  status?: string
  publishedAt?: Date
  budgetMin?: number
  budgetMax?: number
  budgetText?: string
  durationText?: string
  skills?: string[]
  detailStatus?: 'full' | 'fallback'
  listingHash?: string
  detailHash?: string
  contentHash?: string
}

type SourceHealthState = {
  consecutiveFailures: number
  cooldownUntil?: number
  lastSuccessAt?: string
  lastFailureReason?: string
}

const SOURCES: SourceConfig[] = [
  {
    name: 'mostaql',
    url: process.env.MOSTAQL_SCRAPE_URL || 'https://mostaql.com/projects?category=development,ai-machine-learning&sort=latest',
    baseUrl: 'https://mostaql.com'
  },
  {
    name: 'khamsat',
    url: process.env.KHAMSAT_SCRAPE_URL || 'https://khamsat.com/community/requests',
    baseUrl: 'https://khamsat.com'
  },
  {
    name: 'ureed',
    url: process.env.UREED_SCRAPE_URL || 'https://app.ureed.com/find-projects?keyword=',
    baseUrl: 'https://app.ureed.com'
  },
  {
    name: 'baaeed',
    url: process.env.BAAEED_SCRAPE_URL || 'https://baaeed.com/remote-jobs',
    baseUrl: 'https://baaeed.com'
  },
  {
    name: 'nafezly',
    url: process.env.NAFEZLY_SCRAPE_URL || 'https://nafezly.com/projects',
    baseUrl: 'https://nafezly.com'
  },
  {
    name: 'bahr',
    url: process.env.BAHR_SCRAPE_URL || 'https://bahr.sa/projects?sortBy=publishDate_DESC',
    baseUrl: 'https://bahr.sa'
  },
  {
    name: 'forasna',
    url: process.env.FORASNA_SCRAPE_URL || 'https://forasna.com/%D9%88%D8%B8%D8%A7%D8%A6%D9%81-%D8%AE%D8%A7%D9%84%D9%8A%D8%A9?query=',
    baseUrl: 'https://forasna.com'
  },
  {
    name: 'tanqeeb',
    url: process.env.TANQEEB_SCRAPE_URL || 'https://egypt.tanqeeb.com/ar/jobs/search?keywords=&country=-1&state=0&category=-1&workplace=0&search_period=0&lang=all&page_no=1&refine%5Bonly_featured%5D=1',
    baseUrl: 'https://egypt.tanqeeb.com'
  },
  {
    name: 'bayt',
    url: process.env.BAYT_SCRAPE_URL || 'https://www.bayt.com/ar/international/jobs/',
    baseUrl: 'https://www.bayt.com'
  },
  {
    name: 'wuzzuf',
    url: process.env.WUZZUF_SCRAPE_URL || 'https://wuzzuf.net/search/jobs?q=&a=hpb',
    baseUrl: 'https://wuzzuf.net'
  },
  {
    name: 'google_jobs',
    url: process.env.GOOGLE_JOBS_QUERY || 'software developer remote',
    baseUrl: 'https://google.com'
  }
]

const sourceHealth: Record<SourceName, SourceHealthState> = {
  mostaql: { consecutiveFailures: 0 },
  khamsat: { consecutiveFailures: 0 },
  ureed: { consecutiveFailures: 0 },
  baaeed: { consecutiveFailures: 0 },
  nafezly: { consecutiveFailures: 0 },
  bahr: { consecutiveFailures: 0 },
  forasna: { consecutiveFailures: 0 },
  tanqeeb: { consecutiveFailures: 0 },
  bayt: { consecutiveFailures: 0 },
  wuzzuf: { consecutiveFailures: 0 },
  google_jobs: { consecutiveFailures: 0 }
}

let skippedDueToRunning = 0
let consecutiveSlowRuns = 0
let lastTelegramSendTime = 0

export function logEvent(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}): void {
  const payload = {
    event,
    tsUtc: new Date().toISOString(),
    tsLocal: new Date().toString(),
    pid: process.pid,
    ...data
  }
  const serialized = JSON.stringify(payload)
  if (level === 'error') console.error(serialized)
  else if (level === 'warn') console.warn(serialized)
  else console.log(serialized)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}



export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function getEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function looksLikeJobUrl(source: SourceName, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:') return false

  if (source === 'mostaql') {
    return parsed.hostname === 'mostaql.com' && /^\/project\/[0-9]+(?:-|$)/.test(parsed.pathname)
  }

  if (source === 'khamsat') {
    return parsed.hostname === 'khamsat.com' && /^\/community\/requests\/[^/]+/.test(parsed.pathname)
  }

  if (source === 'ureed') return parsed.hostname.includes('ureed.com')
  if (source === 'baaeed') return parsed.hostname.includes('baaeed.com')
  if (source === 'nafezly') return parsed.hostname.includes('nafezly.com')
  if (source === 'bahr') return parsed.hostname.includes('bahr.sa')
  if (source === 'forasna') return parsed.hostname.includes('forasna.com')
  if (source === 'tanqeeb') return parsed.hostname.includes('tanqeeb.com')
  if (source === 'bayt') return parsed.hostname.includes('bayt.com')
  if (source === 'wuzzuf') return parsed.hostname.includes('wuzzuf.net')
  if (source === 'google_jobs') return parsed.hostname.includes('google.com') || parsed.hostname.includes('google.com.eg')

  return false
}

export async function fetchHtml(url: string): Promise<string> {
  return fetchHtmlWithRetry(url, sleep, {
    maxAttempts: getEnvInt('HTTP_RETRY_MAX_ATTEMPTS', 3),
    baseDelayMs: getEnvInt('HTTP_RETRY_BASE_DELAY_MS', 500),
    maxDelayMs: getEnvInt('HTTP_RETRY_MAX_DELAY_MS', 8000),
    timeoutMs: getEnvInt('HTTP_REQUEST_TIMEOUT_MS', 10000)
  }, info => {
    logEvent('warn', 'fetch_retry', info)
  })
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

export function buildListingHash(job: JobPostInput): string {
  return sha1(JSON.stringify({
    sourceProjectId: job.sourceProjectId,
    title: job.title,
    url: job.url
  }))
}

export function buildDetailHash(job: JobPostInput): string {
  return sha1(JSON.stringify({
    description: job.description ?? null,
    rawText: job.rawText ?? null,
    category: job.category ?? null,
    status: job.status ?? null,
    publishedAt: job.publishedAt?.toISOString() ?? null,
    budgetMin: job.budgetMin ?? null,
    budgetMax: job.budgetMax ?? null,
    budgetText: job.budgetText ?? null,
    durationText: job.durationText ?? null,
    skills: job.skills ?? []
  }))
}

export function buildContentHash(job: JobPostInput): string {
  const listingHash = job.listingHash ?? buildListingHash(job)
  const detailHash = job.detailHash ?? buildDetailHash(job)
  return sha1(JSON.stringify({ listingHash, detailHash }))
}

function isRetriableSourceError(error: unknown): boolean {
  if (!(error instanceof FetchHtmlError)) return false
  return error.status === undefined || error.status >= 500 || error.status === 429
}

function getSourceCooldownMs(failureCount: number): number {
  const threshold = getEnvInt('SOURCE_CB_FAILURE_THRESHOLD', 3)
  const base = getEnvInt('SOURCE_CB_COOLDOWN_BASE_MS', 300000)
  const cap = getEnvInt('SOURCE_CB_COOLDOWN_MAX_MS', 1800000)
  if (failureCount < threshold) return 0
  const exponent = Math.max(0, failureCount - threshold)
  return Math.min(cap, base * (3 ** exponent))
}

function parseCronIntervalMs(expr: string): number | null {
  const match = expr.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/)
  if (!match) return null
  const minutesRaw = match.at(1)
  if (!minutesRaw) return null
  const minutes = Number.parseInt(minutesRaw, 10)
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return minutes * 60_000
}

async function scrapeMostaqlProjectDetail(url: string) {
  const html = await fetchHtml(url)
  return parseMostaqlProjectDetail(html)
}

async function scrapeKhamsatSource(source: SourceConfig): Promise<JobPostInput[]> {
  const maxPages = getEnvInt('KHAMSAT_MAX_PAGES', 5)
  const detailConcurrency = getEnvInt('KHAMSAT_DETAIL_CONCURRENCY', 2)
  const requestDelayMs = getEnvInt('KHAMSAT_REQUEST_DELAY_MS', 300)
  const knownThreshold = 0.9

  const listingsById = new Map<string, ReturnType<typeof parseKhamsatListing>[number]>()
  const seenPageIdSetFingerprints = new Set<string>()
  let currentUrl = source.url

  for (let page = 1; page <= maxPages; page += 1) {
    const html = await fetchHtml(currentUrl)
    const rows = parseKhamsatListing(html, source.baseUrl)
    if (rows.length === 0) {
      logEvent('info', 'khamsat_stop', { reason: 'no-rows', page })
      break
    }

    const pageIds = rows.map(r => r.sourceProjectId).sort()
    const fingerprint = pageIds.join(',')
    if (seenPageIdSetFingerprints.has(fingerprint)) {
      logEvent('info', 'khamsat_stop', { reason: 'no-new-ids', page })
      break
    }
    seenPageIdSetFingerprints.add(fingerprint)

    for (const row of rows) listingsById.set(row.sourceProjectId, row)

    const existingCount = await prisma.jobPost.count({
      where: {
        source: 'khamsat',
        sourceProjectId: { in: rows.map(r => r.sourceProjectId) }
      }
    })

    const existingRatio = existingCount / rows.length
    logEvent('info', 'khamsat_page', { page, rows: rows.length, existing: existingCount, ratio: Number(existingRatio.toFixed(2)) })
    if (existingRatio >= knownThreshold) {
      logEvent('info', 'khamsat_stop', { reason: 'known-threshold', page })
      break
    }

    const nextPageUrl = buildKhamsatPageUrl(html, source.baseUrl, page + 1)
    if (!nextPageUrl) {
      logEvent('info', 'khamsat_stop', { reason: 'no-next-page', page })
      break
    }
    currentUrl = nextPageUrl
    await sleep(requestDelayMs)

    if (page === maxPages) {
      logEvent('info', 'khamsat_stop', { reason: 'max-pages', page })
    }
  }

  const listings = Array.from(listingsById.values())
  const existingIds = new Set(
    (await prisma.jobPost.findMany({
      where: { source: 'khamsat', sourceProjectId: { in: listings.map(l => l.sourceProjectId) } },
      select: { sourceProjectId: true }
    })).map(row => row.sourceProjectId)
  )
  const newListings = listings.filter(item => !existingIds.has(item.sourceProjectId))

  const jobs: JobPostInput[] = []
  for (let i = 0; i < newListings.length; i += detailConcurrency) {
    const chunk = newListings.slice(i, i + detailConcurrency)
    const resolved = await Promise.all(chunk.map(async listing => {
      await sleep(requestDelayMs)
      try {
        const detailHtml = await fetchHtml(listing.url)
        const detail = parseKhamsatDetail(detailHtml, source.baseUrl, listing.url)

        const metadataParts = [
          detail.authorName ? `author:${detail.authorName}` : null,
          detail.commentCount !== undefined ? `comments:${detail.commentCount}` : null
        ].filter(Boolean).join(' | ')

        const job: JobPostInput = {
          source: 'khamsat',
          sourceProjectId: listing.sourceProjectId,
          title: detail.title || listing.title,
          url: listing.url,
          description: detail.description || listing.rawText.slice(0, 1000),
          rawText: [detail.rawText, metadataParts].filter(Boolean).join('\n')
        }
        if (detail.category) job.category = detail.category
        if (detail.publishedAt) job.publishedAt = detail.publishedAt
        job.detailStatus = 'full'
        job.listingHash = buildListingHash(job)
        job.detailHash = buildDetailHash(job)
        job.contentHash = buildContentHash(job)
        return job
      } catch (error) {
        const status = error instanceof FetchHtmlError ? error.status : undefined
        logEvent('warn', 'khamsat_detail_failed', {
          sourceProjectId: listing.sourceProjectId,
          url: listing.url,
          status,
          error: String(error)
        })
        const fallbackJob: JobPostInput = {
          source: 'khamsat',
          sourceProjectId: listing.sourceProjectId,
          title: listing.title,
          url: listing.url,
          description: listing.rawText.slice(0, 1000),
          rawText: listing.rawText
        }
        fallbackJob.detailStatus = 'fallback'
        fallbackJob.listingHash = buildListingHash(fallbackJob)
        fallbackJob.detailHash = buildDetailHash(fallbackJob)
        fallbackJob.contentHash = buildContentHash(fallbackJob)
        return fallbackJob
      }
    }))
    jobs.push(...resolved)
  }

  return jobs
}

async function scrapeMostaqlSource(source: SourceConfig): Promise<JobPostInput[]> {
  const maxPages = getEnvInt('MOSTAQL_MAX_PAGES', 3)
  const detailConcurrency = getEnvInt('MOSTAQL_DETAIL_CONCURRENCY', 2)
  const requestDelayMs = getEnvInt('MOSTAQL_REQUEST_DELAY_MS', 300)

  const listings: ReturnType<typeof parseMostaqlListing> = []
  const seenListingIds = new Set<string>()

  let pageUrl = source.url
  for (let page = 1; page <= maxPages; page += 1) {
    const html = await fetchHtml(pageUrl)
    const pageListings = parseMostaqlListing(html, source.baseUrl)

    if (pageListings.length === 0) break

    for (const item of pageListings) {
      if (seenListingIds.has(item.sourceProjectId)) continue
      seenListingIds.add(item.sourceProjectId)
      listings.push(item)
    }

    const existingCount = await prisma.jobPost.count({
      where: {
        source: 'mostaql',
        sourceProjectId: { in: pageListings.map(i => i.sourceProjectId) }
      }
    })

    logEvent('info', 'mostaql_page', { page, rows: pageListings.length, existing: existingCount })

    if (existingCount >= pageListings.length) {
      logEvent('info', 'mostaql_stop', { reason: 'known-threshold', page })
      break
    }

    const $ = cheerio.load(html)
    const nextHref = $(`a[data-page-number="${page + 1}"]`).first().attr('href')
    if (!nextHref) break

    pageUrl = normalizeUrl(nextHref, source.baseUrl)
    await sleep(requestDelayMs)
  }

  const jobs: JobPostInput[] = []

  for (let i = 0; i < listings.length; i += detailConcurrency) {
    const chunk = listings.slice(i, i + detailConcurrency)

    const resolved = await Promise.all(chunk.map(async listing => {
      await sleep(requestDelayMs)
      try {
        const detail = await scrapeMostaqlProjectDetail(listing.url)

        const job: JobPostInput = {
          source: 'mostaql',
          sourceProjectId: listing.sourceProjectId,
          title: detail.title || listing.title,
          url: listing.url,
          description: detail.description || listing.rawText.slice(0, 1000),
          rawText: detail.rawText || listing.rawText
        }
        if (detail.category) job.category = detail.category
        if (detail.status) job.status = detail.status
        if (detail.publishedAt) job.publishedAt = detail.publishedAt
        if (detail.budgetMin !== undefined) job.budgetMin = detail.budgetMin
        if (detail.budgetMax !== undefined) job.budgetMax = detail.budgetMax
        if (detail.budgetText) job.budgetText = detail.budgetText
        if (detail.durationText) job.durationText = detail.durationText
        if (detail.skills?.length) job.skills = detail.skills

        job.detailStatus = 'full'
        job.listingHash = buildListingHash(job)
        job.detailHash = buildDetailHash(job)
        job.contentHash = buildContentHash(job)
        return job
      } catch (error) {
        const status = error instanceof FetchHtmlError ? error.status : undefined
        logEvent('warn', 'mostaql_detail_failed', {
          sourceProjectId: listing.sourceProjectId,
          url: listing.url,
          status,
          error: String(error)
        })
        const fallbackJob: JobPostInput = {
          source: 'mostaql',
          sourceProjectId: listing.sourceProjectId,
          title: listing.title,
          url: listing.url,
          description: listing.rawText.slice(0, 1000),
          rawText: listing.rawText
        }
        fallbackJob.detailStatus = 'fallback'
        fallbackJob.listingHash = buildListingHash(fallbackJob)
        fallbackJob.detailHash = buildDetailHash(fallbackJob)
        fallbackJob.contentHash = buildContentHash(fallbackJob)
        return fallbackJob
      }
    }))

    jobs.push(...resolved)
  }

  return jobs
}

async function scrapeSource(source: SourceConfig): Promise<JobPostInput[]> {
  if (source.name === 'mostaql') return scrapeMostaqlSource(source)
  if (source.name === 'khamsat') return scrapeKhamsatSource(source)
  if (source.name === 'ureed') return scrapeUreedSource(source)
  if (source.name === 'baaeed') return scrapeBaaeedSource(source)
  if (source.name === 'nafezly') return scrapeNafezlySource(source)
  if (source.name === 'bahr') return scrapeBahrSource(source)
  if (source.name === 'forasna') return scrapeForasnaSource(source)
  if (source.name === 'tanqeeb') return scrapeTanqeebSource(source)
  if (source.name === 'bayt') return scrapeBaytSource(source)
  if (source.name === 'wuzzuf') return scrapeWuzzufSource(source)
  if (source.name === 'google_jobs') return scrapeGoogleJobsSource(source)
  throw new Error(`Unknown source: ${source.name}`)
}





function validateStartupConfig(): void {
  requireEnv('TELEGRAM_BOT_TOKEN')
  requireEnv('TELEGRAM_CHAT_ID')
}

async function validateDatabaseConnection(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (error) {
    throw new Error(`Database connection failed. Ensure native dependencies are installed (try: pnpm rebuild better-sqlite3). Original error: ${String(error)}`)
  }
}

async function sendTelegramMessage(text: string): Promise<void> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN')
  const chatId = requireEnv('TELEGRAM_CHAT_ID')
  const minDelay = getEnvInt('TELEGRAM_MIN_DELAY_MS', 2000)
  const maxAttempts = getEnvInt('TELEGRAM_MAX_ATTEMPTS', 5)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const now = Date.now()
    const timeSinceLastSend = now - lastTelegramSendTime
    if (timeSinceLastSend < minDelay) {
      await sleep(minDelay - timeSinceLastSend)
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false })
    })

    if (res.ok) {
      lastTelegramSendTime = Date.now()
      return
    }

    const body = await res.text()

    if (res.status === 429) {
      let retryAfter = 30
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed.parameters?.retry_after === 'number') {
          retryAfter = parsed.parameters.retry_after
        }
      } catch {
        // Ignore JSON parsing errors
      }

      logEvent('warn', 'telegram_rate_limited', {
        attempt,
        retryAfterSec: retryAfter,
        description: `Telegram 429 rate limit hit. Retrying in ${retryAfter}s.`
      })

      await sleep((retryAfter * 1000) + 1000)
      continue
    }

    throw new Error(`Telegram send failed: ${res.status} ${body}`)
  }

  throw new Error(`Telegram send failed after ${maxAttempts} rate limit retries`)
}

async function saveAndNotify(job: JobPostInput): Promise<'created' | 'updated' | 'skipped'> {
  let existing = await prisma.jobPost.findUnique({
    where: { source_sourceProjectId: { source: job.source, sourceProjectId: job.sourceProjectId } }
  })

  if (!existing) {
    existing = await prisma.jobPost.findUnique({ where: { url: job.url } })
  }

  if (!existing) {
    let saved
    try {
      saved = await prisma.jobPost.create({
        data: {
          source: job.source,
          sourceProjectId: job.sourceProjectId,
          title: job.title,
          url: job.url,
          description: job.description ?? null,
          rawText: job.rawText ?? null,
          category: job.category ?? null,
          status: job.status ?? null,
          publishedAt: job.publishedAt ?? null,
          budgetMin: job.budgetMin ?? null,
          budgetMax: job.budgetMax ?? null,
          budgetText: job.budgetText ?? null,
          durationText: job.durationText ?? null,
          skills: job.skills ? JSON.stringify(job.skills) : null,
          lastSeenAt: new Date(),
          contentHash: job.contentHash ?? null
        }
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existingByUrl = await prisma.jobPost.findUnique({ where: { url: job.url } })
        if (existingByUrl) {
          existing = existingByUrl
        } else {
          throw error
        }
      } else {
        throw error
      }
    }

    if (!existing && saved) {
      try {
        if (isTechJob(job)) {
          await sendTelegramMessage(formatTelegramMessage(job))
          await prisma.jobPost.update({ where: { id: saved.id }, data: { sentAt: new Date() } })
          logEvent('info', 'job_saved_and_sent', { source: job.source, sourceProjectId: job.sourceProjectId, title: job.title })
        } else {
          logEvent('info', 'job_saved_filtered', { source: job.source, sourceProjectId: job.sourceProjectId, title: job.title })
        }
      } catch (error) {
        logEvent('error', 'notify_failed', {
          source: job.source,
          sourceProjectId: job.sourceProjectId,
          jobId: saved.id,
          error: String(error)
        })
      }
      return 'created'
    }
  }

  if (!existing) return 'skipped'

  const now = new Date()
  const nextHash = job.contentHash ?? buildContentHash(job)
  const detailStatus = job.detailStatus ?? 'full'
  const shouldUpdateRichFields = detailStatus === 'full'
  const changed = shouldUpdateRichFields
    ? existing.contentHash !== nextHash
    : (
      existing.title !== job.title
      || existing.url !== job.url
      || existing.status !== (job.status ?? null)
    )
  const data: Prisma.JobPostUpdateInput = {
    title: job.title,
    url: job.url,
    status: job.status ?? null,
    lastSeenAt: now,
    contentHash: shouldUpdateRichFields ? nextHash : existing.contentHash
  }

  if (shouldUpdateRichFields) {
    data.description = job.description ?? null
    data.rawText = job.rawText ?? null
    data.category = job.category ?? null
    data.publishedAt = job.publishedAt ?? null
    data.budgetMin = job.budgetMin ?? null
    data.budgetMax = job.budgetMax ?? null
    data.budgetText = job.budgetText ?? null
    data.durationText = job.durationText ?? null
    data.skills = job.skills ? JSON.stringify(job.skills) : null
  }

  await prisma.jobPost.update({
    where: { id: existing.id },
    data
  })

  if (changed) {
    logEvent('info', 'job_updated', {
      source: job.source,
      sourceProjectId: job.sourceProjectId,
      title: job.title,
      detailStatus
    })
    return 'updated'
  }

  return 'skipped'
}

async function runOnce(): Promise<void> {
  const runStart = Date.now()
  logEvent('info', 'run_started')

  for (const source of SOURCES) {
    const health = sourceHealth[source.name]
    const now = Date.now()
    if (health.cooldownUntil && now < health.cooldownUntil) {
      logEvent('warn', 'source_skipped_cooldown', {
        source: source.name,
        cooldownUntil: new Date(health.cooldownUntil).toISOString(),
        cooldownRemainingMs: health.cooldownUntil - now,
        consecutiveFailures: health.consecutiveFailures
      })
      continue
    }

    const sourceStart = Date.now()
    try {
      const jobs = await scrapeSource(source)
      logEvent('info', 'source_jobs_found', { source: source.name, jobs: jobs.length })

      let created = 0
      let updated = 0
      let skipped = 0

      for (const job of jobs) {
        const result = await saveAndNotify(job)
        if (result === 'created') created += 1
        else if (result === 'updated') updated += 1
        else skipped += 1
      }

      health.consecutiveFailures = 0
      delete health.cooldownUntil
      delete health.lastFailureReason
      health.lastSuccessAt = new Date().toISOString()
      logEvent('info', 'source_completed', {
        source: source.name,
        created,
        updated,
        skipped,
        sourceDurationMs: Date.now() - sourceStart
      })
    } catch (error) {
      const retriable = isRetriableSourceError(error)
      if (retriable) {
        health.consecutiveFailures += 1
        const cooldownMs = getSourceCooldownMs(health.consecutiveFailures)
        if (cooldownMs > 0) {
          health.cooldownUntil = Date.now() + cooldownMs
        }
      }
      health.lastFailureReason = String(error)
      logEvent('error', 'source_failed', {
        source: source.name,
        retriable,
        consecutiveFailures: health.consecutiveFailures,
        cooldownUntil: health.cooldownUntil ? new Date(health.cooldownUntil).toISOString() : null,
        sourceDurationMs: Date.now() - sourceStart,
        error: String(error)
      })
    }
  }

  const runDurationMs = Date.now() - runStart
  const maxRunDurationMs = getEnvInt('MAX_RUN_DURATION_MS', 60000)
  if (runDurationMs > maxRunDurationMs) {
    consecutiveSlowRuns += 1
    logEvent('warn', 'run_slow', { runDurationMs, maxRunDurationMs, consecutiveSlowRuns })
  } else {
    consecutiveSlowRuns = 0
  }
  const cronIntervalMs = parseCronIntervalMs(process.env.CRON_EXPR || '*/3 * * * *')
  if (cronIntervalMs !== null && runDurationMs > cronIntervalMs) {
    logEvent('warn', 'run_exceeds_cron_interval', {
      runDurationMs,
      cronIntervalMs,
      recommendation: 'Increase CRON_EXPR interval or reduce per-run work.'
    })
  }
  if (consecutiveSlowRuns >= 3) {
    logEvent('warn', 'run_consistently_slow', {
      consecutiveSlowRuns,
      runDurationMs,
      maxRunDurationMs,
      recommendation: 'Increase CRON_EXPR, reduce source pages/concurrency, or add queue workers.'
    })
  }
  logEvent('info', 'run_finished', { runDurationMs })
}

async function main(): Promise<void> {
  validateStartupConfig()
  await validateDatabaseConnection()
  const cronExpr = process.env.CRON_EXPR || '*/3 * * * *'
  const heartbeatIntervalMs = getEnvInt('HEARTBEAT_INTERVAL_MS', 15000)
  const heartbeatStallWarnMs = getEnvInt('HEARTBEAT_STALL_WARN_MS', 10000)
  const loopLag = monitorEventLoopDelay({ resolution: 20 })
  loopLag.enable()

  let running = false

  let lastHeartbeat = Date.now()
  setInterval(() => {
    const now = Date.now()
    const driftMs = now - lastHeartbeat - heartbeatIntervalMs
    if (driftMs > heartbeatStallWarnMs) {
      logEvent('warn', 'scheduler_stall_detected', {
        heartbeatDelayMs: driftMs,
        uptimeSec: Math.round(process.uptime()),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    } else {
      logEvent('info', 'heartbeat', {
        heartbeatDelayMs: driftMs,
        uptimeSec: Math.round(process.uptime()),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    }
    lastHeartbeat = now
  }, heartbeatIntervalMs)

  await runOnce()

  cron.schedule(cronExpr, async () => {
    if (running) {
      skippedDueToRunning += 1
      logEvent('warn', 'run_skipped_running', { skippedDueToRunning })
      return
    }

    running = true
    try {
      loopLag.reset()
      await runOnce()
      logEvent('info', 'event_loop_lag', {
        eventLoopLagP95Ms: Number((loopLag.percentile(95) / 1_000_000).toFixed(2)),
        eventLoopLagMaxMs: Number((loopLag.max / 1_000_000).toFixed(2))
      })
    } finally {
      running = false
    }
  })

  logEvent('info', 'bot_scheduled', { cronExpr, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void prisma.$disconnect().finally(() => process.exit(0))
  })
}

import { fileURLToPath } from 'node:url'

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('/index.ts') ||
  process.argv[1].endsWith('/index.js')
)

if (isMain) {
  main().catch(async error => {
    console.error('Fatal bot error:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
}
