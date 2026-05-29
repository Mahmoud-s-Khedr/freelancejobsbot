import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, fetchHtml, sleep, logEvent } from './index.js'
import { prisma } from './db.js'
import * as cheerio from 'cheerio'

export async function scrapeBaytSource(source: SourceConfig): Promise<JobPostInput[]> {
  let listHtml: string;
  try {
    listHtml = await fetchHtml(source.url);
  } catch (err: any) {
    if (err.status === 403) {
      logEvent('warn', 'bayt_cf_blocked', { url: source.url, status: 403 });
      return []; // Return empty list gracefully when blocked by Cloudflare
    }
    throw err;
  }

  const $ = cheerio.load(listHtml);
  const listings: { title: string; url: string; sourceProjectId: string; fallbackDesc: string }[] = [];

  $('li[data-js-job]').each((_, el) => {
    const titleEl = $(el).find('h2.t-large a');
    const jobKey = $(el).attr('data-job-id') || $(el).attr('data-js-job') || '';
    
    if (titleEl.length > 0) {
      const title = titleEl.text().trim();
      let href = titleEl.attr('href') || '';
      if (href) {
        const fullUrl = new URL(href, source.baseUrl).href;
        
        // Extract project ID from URL or attribute
        let projectId = jobKey;
        if (!projectId) {
          const match = href.match(/-(\d+)\/?$/);
          projectId = match?.[1] || '';
        }

        // Fallback description from listing card (div containing "ملخص:")
        let fallbackDesc = '';
        $(el).find('div').each((_, divEl) => {
          const divText = $(divEl).text().trim();
          if (divText.startsWith('ملخص:')) {
            fallbackDesc = divText.replace(/^ملخص:\s*/, '');
          }
        });

        if (projectId) {
          listings.push({
            title,
            url: fullUrl,
            sourceProjectId: projectId,
            fallbackDesc
          });
        }
      }
    }
  });

  logEvent('info', 'bayt_listings_parsed', { count: listings.length });

  if (listings.length === 0) {
    return [];
  }

  // Filter out existing ones
  const existingPosts = await prisma.jobPost.findMany({
    where: {
      source: 'bayt',
      sourceProjectId: { in: listings.map(l => l.sourceProjectId) }
    },
    select: { sourceProjectId: true }
  });

  const existingIds = new Set(existingPosts.map(p => p.sourceProjectId));
  const newListings = listings.filter(l => !existingIds.has(l.sourceProjectId));

  logEvent('info', 'bayt_new_listings', { count: newListings.length });

  const jobs: JobPostInput[] = [];

  for (const item of newListings) {
    await sleep(500); // polite delay
    try {
      let detailHtml = '';
      try {
        detailHtml = await fetchHtml(item.url);
      } catch (err: any) {
        if (err.status === 403) {
          logEvent('warn', 'bayt_detail_cf_blocked', { url: item.url, status: 403 });
          // Fall back to listing metadata if detail page is blocked
        } else {
          throw err;
        }
      }

      let cleanDesc = item.fallbackDesc;
      let skills: string[] = [];

      if (detailHtml) {
        const detail$ = cheerio.load(detailHtml);
        
        // Find job description
        const descContainer = detail$('.job-description, [itemprop="description"], .card-body').first();
        if (descContainer.length > 0) {
          cleanDesc = descContainer.text().trim();
        }

        // Extract skills
        detail$('a[href*="/skills/"], .tag, .badge').each((_, el) => {
          const skill = detail$(el).text().trim();
          if (skill && skill.length < 30) {
            skills.push(skill);
          }
        });
      }

      const job: JobPostInput = {
        source: 'bayt',
        sourceProjectId: item.sourceProjectId,
        title: item.title,
        url: item.url,
        description: cleanDesc,
        rawText: cleanDesc,
        category: 'Software Development',
        publishedAt: new Date(),
        skills,
        detailStatus: detailHtml ? 'full' : 'fallback'
      };

      job.listingHash = buildListingHash(job);
      job.detailHash = buildDetailHash(job);
      job.contentHash = buildContentHash(job);

      jobs.push(job);
    } catch (err: any) {
      logEvent('error', 'bayt_detail_error', { url: item.url, error: err.message });
    }
  }

  return jobs;
}
