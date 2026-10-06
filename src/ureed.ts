import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash } from './index.js'
import * as cheerio from 'cheerio'
import { fetchJsonWithRetry } from './http.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function scrapeUreedSource(source: SourceConfig): Promise<JobPostInput[]> {
  const query = `
    query allProjects($filters: AllProjectsFiltersInput) {
      allProjects(filters: $filters) {
        projects {
          id
          name
          budget
          budgetType
          description
          publishedOn
          category {
            name
            nameAr
          }
          skills {
            name
          }
        }
      }
    }
  `;

  const url = source.url || 'https://graphql.ureed.com/graphql'
  const jobs: JobPostInput[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= 100; page++) {
  const body = JSON.stringify({
    query,
    variables: {
      filters: {
        categories: [],
        page,
        size: 50,
        text: ''
      }
    }
  })
  const result = await fetchJsonWithRetry<Record<string, any>>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  }, sleep, {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    timeoutMs: 10000
  })
  if (result.errors?.length) throw new Error(`Ureed GraphQL errors: ${JSON.stringify(result.errors)}`)
  const projects = result?.data?.allProjects?.projects
  if (!Array.isArray(projects)) throw new Error('Malformed Ureed projects payload')
  if (!projects.length) return jobs

  for (const proj of projects) {
    if (!proj.id || !proj.name) throw new Error('Invalid Ureed job')
    const id = String(proj.id)
    if (seen.has(id)) throw new Error('Repeated Ureed page')
    seen.add(id)
    const projectUrl = `https://app.ureed.com/project/${id}`
    
    // Clean description HTML to plain text
    const cleanDesc = proj.description ? cheerio.load(proj.description).text().trim() : ''
    
    // Skills
    const skillsList = Array.isArray(proj.skills)
      ? proj.skills.map((s: any) => s.name).filter(Boolean)
      : []

    // Category
    const categoryName = proj.category?.name || proj.category?.nameAr || ''

    const budgetVal = proj.budget ? Number(proj.budget) : undefined

    const job: JobPostInput = {
      source: 'ureed',
      sourceProjectId: id,
      title: proj.name || '',
      url: projectUrl,
      description: cleanDesc,
      rawText: cleanDesc,
      category: categoryName,
      skills: skillsList,
      detailStatus: 'full'
    }

    if (proj.publishedOn) {
      const d = new Date(proj.publishedOn)
      if (Number.isFinite(d.getTime())) job.publishedAt = d
    }
    if (budgetVal !== undefined) {
      job.budgetMin = budgetVal
      job.budgetText = String(budgetVal)
    }

    job.listingHash = buildListingHash(job)
    job.detailHash = buildDetailHash(job)
    job.contentHash = buildContentHash(job)

    jobs.push(job)
  }

    if (projects.length < 50) return jobs
    await sleep(1000)
  }
  throw new Error('Ureed pagination capped')
}
