import * as cheerio from 'cheerio'
import { normalizeUrl } from './mostaql.js'
import { cleanText } from './utils.js'

export type KhamsatListingItem = {
  source: 'khamsat'
  sourceProjectId: string
  title: string
  url: string
  authorName?: string
  authorProfileUrl?: string
  publishedAt?: Date
  latestInteractionAt?: Date
  rawText: string
}

export type KhamsatDetailData = {
  sourceProjectId: string
  title?: string
  url: string
  description?: string
  rawText?: string
  category?: string
  publishedAt?: Date
  authorName?: string
  authorProfileUrl?: string
  commentCount?: number
}


function parseKhamsatGmtDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined
  const match = raw.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT/)
  if (!match) return undefined

  const day = Number.parseInt(match[1] ?? '', 10)
  const month = Number.parseInt(match[2] ?? '', 10)
  const year = Number.parseInt(match[3] ?? '', 10)
  const hour = Number.parseInt(match[4] ?? '', 10)
  const minute = Number.parseInt(match[5] ?? '', 10)
  const second = Number.parseInt(match[6] ?? '', 10)

  if (![day, month, year, hour, minute, second].every(Number.isFinite)) return undefined
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function extractKhamsatRequestId(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'khamsat.com') return null
  const match = parsed.pathname.match(/^\/community\/requests\/(\d+)(?:-|$)/)
  return match?.[1] ?? null
}

function getHiddenPageBase($: cheerio.CheerioAPI): string {
  const value = $('#community_page_url').attr('value')?.trim()
  if (!value) return '/community/requests'
  return value.startsWith('/') ? value : `/${value}`
}

export function buildKhamsatPageUrl(html: string, baseUrl: string, page: number): string | null {
  if (page <= 1) return `${baseUrl}/community/requests`
  const $ = cheerio.load(html)
  const pageBasePath = getHiddenPageBase($)
  if (!pageBasePath) return null
  return `${baseUrl}${pageBasePath}?page=${page}`
}

export function parseKhamsatListing(html: string, baseUrl: string): KhamsatListingItem[] {
  const $ = cheerio.load(html)
  const out = new Map<string, KhamsatListingItem>()

  $('tr.forum_post').each((_, row) => {
    const titleAnchor = $(row).find('h3.details-head a.ajaxbtn').first()
    const href = titleAnchor.attr('href')
    if (!href) return

    const url = normalizeUrl(href, baseUrl)
    const sourceProjectId = extractKhamsatRequestId(url)
    if (!sourceProjectId) return

    const title = cleanText(titleAnchor.text())
    if (!title) return

    const authorAnchor = $(row).find('td.details-td .details-list a.user').first()
    const authorName = cleanText(authorAnchor.clone().find('i').remove().end().text()) || undefined
    const authorHref = authorAnchor.attr('href')
    const authorProfileUrl = authorHref ? normalizeUrl(authorHref, baseUrl) : undefined

    const publishedAtTitle = $(row).find('td.details-td .details-list span[title]').first().attr('title')
    const publishedAt = parseKhamsatGmtDate(publishedAtTitle)

    const latestTitle = $(row).find('td.d-lg-block span[title], td.d-lg-block .details-list span[title]').first().attr('title')
    const latestInteractionAt = parseKhamsatGmtDate(latestTitle)

    const rawText = cleanText($(row).text())

    const item: KhamsatListingItem = {
      source: 'khamsat',
      sourceProjectId,
      title,
      url,
      rawText
    }
    if (authorName) item.authorName = authorName
    if (authorProfileUrl) item.authorProfileUrl = authorProfileUrl
    if (publishedAt) item.publishedAt = publishedAt
    if (latestInteractionAt) item.latestInteractionAt = latestInteractionAt
    out.set(sourceProjectId, item)
  })

  return Array.from(out.values())
}

export function parseKhamsatDetail(html: string, baseUrl: string, fallbackUrl: string): KhamsatDetailData {
  const $ = cheerio.load(html)

  const canonicalUrl = normalizeUrl(
    $('meta[property="og:url"]').attr('content')
      || $('h1 + a').attr('href')
      || fallbackUrl,
    baseUrl
  )
  const sourceProjectId = extractKhamsatRequestId(fallbackUrl) ?? extractKhamsatRequestId(canonicalUrl) ?? fallbackUrl

  const title = cleanText($('.page_header h1').first().text() || $('title').first().text())

  const bodyText = cleanText($('.js-page > .card .card-body article.replace_urls').first().text())

  const breadcrumbs = $('.breadcrumb .breadcrumb-item a').toArray().map(el => cleanText($(el).text())).filter(Boolean)
  const category = breadcrumbs.find(item => item.includes('طلبات الخدمات غير الموجودة'))

  const publishTitle = $('#community_sidebar span[title*="GMT"]').first().attr('title')
    || $('.card.u-hidden\\@medium span[title*="GMT"]').first().attr('title')
  const publishedAt = parseKhamsatGmtDate(publishTitle)

  const publisherAnchor = $('#community_sidebar a.sidebar_user').first()
  const authorName = cleanText(publisherAnchor.text()) || undefined
  const authorHref = publisherAnchor.attr('href')
  const authorProfileUrl = authorHref ? normalizeUrl(authorHref, baseUrl) : undefined

  const commentsHeaderText = cleanText($('.js-page .card-header h3').filter((_, el) => cleanText($(el).text()).includes('التعليقات')).first().text())
  const commentsMatch = commentsHeaderText.match(/التعليقات\s*\((\d+)\)/)
  const commentCount = commentsMatch?.[1] ? Number.parseInt(commentsMatch[1], 10) : undefined

  const out: KhamsatDetailData = {
    sourceProjectId,
    url: fallbackUrl,
    rawText: cleanText(`${title}\n${bodyText}`),
  }
  if (title) out.title = title
  if (bodyText) out.description = bodyText
  if (category) out.category = category
  if (publishedAt) out.publishedAt = publishedAt
  if (authorName) out.authorName = authorName
  if (authorProfileUrl) out.authorProfileUrl = authorProfileUrl
  if (commentCount !== undefined && Number.isFinite(commentCount)) out.commentCount = commentCount
  return out
}
