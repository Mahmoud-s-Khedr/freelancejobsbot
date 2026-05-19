import * as cheerio from 'cheerio'

export type MostaqlListingItem = {
  source: 'mostaql'
  sourceProjectId: string
  title: string
  url: string
  rawText: string
  publishedRelativeText?: string
  bidCountText?: string
}

export type MostaqlDetailData = {
  title?: string
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
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeUrl(href: string, baseUrl: string): string {
  const trimmedHref = href.trim()

  if (trimmedHref.startsWith('http://') || trimmedHref.startsWith('https://')) {
    return trimmedHref
  }

  if (trimmedHref.startsWith('/')) {
    return `${baseUrl}${trimmedHref}`
  }

  return `${baseUrl}/${trimmedHref}`
}

export function extractMostaqlProjectId(url: string): string | null {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.hostname !== 'mostaql.com') {
    return null
  }

  const match = parsed.pathname.match(/^\/project\/(\d+)(?:-|$)/)
  return match?.[1] ?? null
}

function parseUsdRange(text: string): { min?: number; max?: number } {
  const nums = Array.from(text.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g))
    .map(m => {
      const captured = m[1]
      if (!captured) return Number.NaN
      return Number.parseInt(captured.replaceAll(',', ''), 10)
    })
    .filter(n => Number.isFinite(n))

  if (nums.length >= 2) {
    const out: { min?: number; max?: number } = {}
    if (nums[0] !== undefined) out.min = nums[0]
    if (nums[1] !== undefined) out.max = nums[1]
    return out
  }

  if (nums.length === 1) {
    const out: { min?: number; max?: number } = {}
    if (nums[0] !== undefined) {
      out.min = nums[0]
      out.max = nums[0]
    }
    return out
  }

  return {}
}

function parseMostaqlJsonLd($: cheerio.CheerioAPI): Partial<MostaqlDetailData> {
  const scripts = $('script[type="application/ld+json"]')
  for (const script of scripts.toArray()) {
    const raw = $(script).text().trim()
    if (!raw) continue

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed['@type'] !== 'JobPosting') continue

      const out: Partial<MostaqlDetailData> = {}

      if (typeof parsed.description === 'string') {
        out.description = cleanText(parsed.description)
      }

      if (typeof parsed.datePosted === 'string') {
        const d = new Date(parsed.datePosted)
        if (!Number.isNaN(d.getTime())) out.publishedAt = d
      }

      if (typeof parsed.skills === 'string') {
        out.skills = parsed.skills.split('،').map(s => cleanText(s)).filter(Boolean)
      }

      const baseSalary = parsed.baseSalary as Record<string, unknown> | undefined
      const value = baseSalary?.value as number | undefined
      if (typeof value === 'number' && Number.isFinite(value)) {
        out.budgetMax = Math.round(value)
      }

      return out
    } catch {
      continue
    }
  }

  return {}
}

export function parseMostaqlListing(html: string, baseUrl: string): MostaqlListingItem[] {
  const $ = cheerio.load(html)
  const jobsById = new Map<string, MostaqlListingItem>()

  $('tr.project-row').each((_, row) => {
    const titleAnchor = $(row).find('.card--title h2 a').first()
    const briefAnchor = $(row).find('.project__brief a.details-url').first()
    const chosenAnchor = titleAnchor.length ? titleAnchor : briefAnchor

    const href = chosenAnchor.attr('href')
    if (!href) return

    const url = normalizeUrl(href, baseUrl)
    const sourceProjectId = extractMostaqlProjectId(url)
    if (!sourceProjectId) return

    const title = cleanText(chosenAnchor.text())
    if (!title || title.length < 5) return

    const rawText = cleanText($(row).text())
    const publishedRelativeText = cleanText($(row).find('.project__meta time').first().text()) || undefined
    const bidCountText = cleanText($(row).find('.project__meta .hsoub-file-signature-icon').parent().text()) || undefined

    const item: MostaqlListingItem = {
      source: 'mostaql',
      sourceProjectId,
      title,
      url,
      rawText
    }
    if (publishedRelativeText) item.publishedRelativeText = publishedRelativeText
    if (bidCountText) item.bidCountText = bidCountText
    jobsById.set(sourceProjectId, item)
  })

  return Array.from(jobsById.values())
}

export function parseMostaqlProjectDetail(html: string): MostaqlDetailData {
  const $ = cheerio.load(html)

  const title = cleanText(
    $('[data-type="page-header-title"]').first().text()
    || $('h1').first().text()
    || $('title').first().text().replace('| مستقل', '')
  )

  const description = cleanText($('#projectDetailsTab .carda__content').first().text())

  const breadcrumbItems = $('.breadcrumb .breadcrumb-item bdi').toArray().map(el => cleanText($(el).text())).filter(Boolean)
  const category = breadcrumbItems.length >= 2 ? breadcrumbItems[breadcrumbItems.length - 1] : undefined

  const metaRows = $('.meta-container .meta-row')
  let status: string | undefined
  let publishedAt: Date | undefined
  let budgetText: string | undefined
  let durationText: string | undefined

  metaRows.each((_, row) => {
    const label = cleanText($(row).find('.meta-label').first().text())
    const valueText = cleanText($(row).find('.meta-value').first().text())

    if (label.includes('حالة المشروع') && valueText) status = valueText
    if (label.includes('الميزانية') && valueText) budgetText = valueText
    if (label.includes('مدة التنفيذ') && valueText) durationText = valueText

    if (label.includes('تاريخ النشر')) {
      const dt = $(row).find('time').attr('datetime')
      if (dt) {
        const d = new Date(dt)
        if (!Number.isNaN(d.getTime())) publishedAt = d
      }
    }
  })

  const skills = $('.skills .skills__item a.tag bdi, .skills .skills__item a.tag').toArray()
    .map(el => cleanText($(el).text()))
    .filter(Boolean)

  const usdRange = parseUsdRange(budgetText ?? '')
  const jsonLd = parseMostaqlJsonLd($)

  const out: MostaqlDetailData = {
    rawText: cleanText(`${title}\n${description}`)
  }
  const safeTitle = title || jsonLd.title
  if (safeTitle) out.title = safeTitle
  const safeDescription = description || jsonLd.description
  if (safeDescription) out.description = safeDescription
  if (category) out.category = category
  if (status) out.status = status
  const safePublishedAt = publishedAt ?? jsonLd.publishedAt
  if (safePublishedAt) out.publishedAt = safePublishedAt
  if (usdRange.min !== undefined) out.budgetMin = usdRange.min
  const safeBudgetMax = usdRange.max ?? jsonLd.budgetMax
  if (safeBudgetMax !== undefined) out.budgetMax = safeBudgetMax
  if (budgetText) out.budgetText = budgetText
  if (durationText) out.durationText = durationText
  if (skills.length) out.skills = skills
  else if (jsonLd.skills?.length) out.skills = jsonLd.skills
  return out
}
