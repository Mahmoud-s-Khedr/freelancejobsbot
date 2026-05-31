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
  const body = JSON.stringify({
    query,
    variables: {
      filters: {
        categories: [],
        page: 1,
        size: 15,
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
  const projects = result?.data?.allProjects?.projects || []

  const jobs: JobPostInput[] = []
  for (const proj of projects) {
    const id = String(proj.id)
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
      job.publishedAt = new Date(proj.publishedOn)
    }
    if (budgetVal !== undefined) {
      job.budgetMin = budgetVal
      job.budgetText = `$${budgetVal}`
    }

    job.listingHash = buildListingHash(job)
    job.detailHash = buildDetailHash(job)
    job.contentHash = buildContentHash(job)

    jobs.push(job)
  }

  return jobs
}
