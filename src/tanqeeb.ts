import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, fetchHtml, sleep, logEvent } from './index.js'
import { prisma } from './db.js'
import * as cheerio from 'cheerio'

export async function scrapeTanqeebSource(source: SourceConfig): Promise<JobPostInput[]> {
  const listHtml = await fetchHtml(source.url);
  const $ = cheerio.load(listHtml);

  const listings: { title: string; url: string; sourceProjectId: string }[] = [];

  $('article.card').each((_, el) => {
    const id = $(el).attr('data-id') || '';
    const titleEl = $(el).find('h5');
    const linkEl = $(el).find('a.position-absolute');
    
    if (id && titleEl.length > 0 && linkEl.length > 0) {
      const title = titleEl.text().trim();
      const relativeUrl = linkEl.attr('href') || '';
      if (relativeUrl) {
        const fullUrl = new URL(relativeUrl, source.baseUrl).href;
        listings.push({
          title,
          url: fullUrl,
          sourceProjectId: id
        });
      }
    }
  });

  logEvent('info', 'tanqeeb_listings_parsed', { count: listings.length });

  if (listings.length === 0) {
    return [];
  }

  // Filter out existing ones
  const existingPosts = await prisma.jobPost.findMany({
    where: {
      source: 'tanqeeb',
      sourceProjectId: { in: listings.map(l => l.sourceProjectId) }
    },
    select: { sourceProjectId: true }
  });

  const existingIds = new Set(existingPosts.map(p => p.sourceProjectId));
  const newListings = listings.filter(l => !existingIds.has(l.sourceProjectId));

  logEvent('info', 'tanqeeb_new_listings', { count: newListings.length });

  const jobs: JobPostInput[] = [];

  for (const item of newListings) {
    await sleep(500); // polite delay
    try {
      const detailHtml = await fetchHtml(item.url);
      const detail$ = cheerio.load(detailHtml);

      // Description is inside .text-html
      const cleanDesc = detail$('.text-html').text().trim();

      // Meta / Salary
      let budgetMin: number | undefined;
      let budgetMax: number | undefined;
      let budgetText: string | undefined;

      detail$('.card').each((_, cardEl) => {
        const text = detail$(cardEl).text().replace(/\s+/g, ' ').trim();
        if (text.includes('الراتب')) {
          const match = text.match(/الراتب\s+([^\s]+(?:\s+[^\s]+)*)/);
          if (match && match[1]) {
            const val = match[1].split(' ')[0];
            if (val && val !== 'Confidential' && val !== 'غير' && val !== 'غير معلن') {
              budgetText = match[1];
              const nums = match[1].match(/\d+/g);
              if (nums && nums.length >= 2) {
                budgetMin = Number(nums[0]);
                budgetMax = Number(nums[1]);
              } else if (nums && nums.length === 1) {
                budgetMin = Number(nums[0]);
              }
            }
          }
        }
      });

      const job: JobPostInput = {
        source: 'tanqeeb',
        sourceProjectId: item.sourceProjectId,
        title: item.title,
        url: item.url,
        description: cleanDesc,
        rawText: cleanDesc,
        publishedAt: new Date(),
        skills: [],
        detailStatus: 'full'
      };

      if (budgetMin !== undefined) job.budgetMin = budgetMin;
      if (budgetMax !== undefined) job.budgetMax = budgetMax;
      if (budgetText !== undefined) job.budgetText = budgetText;

      job.listingHash = buildListingHash(job);
      job.detailHash = buildDetailHash(job);
      job.contentHash = buildContentHash(job);

      jobs.push(job);
    } catch (err: any) {
      logEvent('error', 'tanqeeb_detail_error', { url: item.url, error: err.message });
    }
  }

  return jobs;
}
