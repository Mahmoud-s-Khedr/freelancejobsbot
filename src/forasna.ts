import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, fetchHtml, sleep, logEvent } from './index.js'
import { prisma } from './db.js'
import * as cheerio from 'cheerio'

export async function scrapeForasnaSource(source: SourceConfig): Promise<JobPostInput[]> {
  const listHtml = await fetchHtml(source.url);
  const $ = cheerio.load(listHtml);

  const listings: { title: string; url: string; sourceProjectId: string }[] = [];

  $('div.result-wrp').each((_, el) => {
    const titleEl = $(el).find('h2.job-title a');
    if (titleEl.length > 0) {
      const title = titleEl.text().trim();
      const href = titleEl.attr('href') || '';
      if (href) {
        // Extract project/job ID at the end of the slug
        const match = href.match(/-(\d+)(?:\?|$)/);
        const projectId = match?.[1] || '';
        if (projectId) {
          listings.push({
            title,
            url: href,
            sourceProjectId: projectId
          });
        }
      }
    }
  });

  logEvent('info', 'forasna_listings_parsed', { count: listings.length });

  if (listings.length === 0) {
    return [];
  }

  // Filter out existing ones
  const existingPosts = await prisma.jobPost.findMany({
    where: {
      source: 'forasna',
      sourceProjectId: { in: listings.map(l => l.sourceProjectId) }
    },
    select: { sourceProjectId: true }
  });

  const existingIds = new Set(existingPosts.map(p => p.sourceProjectId));
  const newListings = listings.filter(l => !existingIds.has(l.sourceProjectId));

  logEvent('info', 'forasna_new_listings', { count: newListings.length });

  const jobs: JobPostInput[] = [];

  for (const item of newListings) {
    await sleep(500); // polite delay
    try {
      const detailHtml = await fetchHtml(item.url);
      const detail$ = cheerio.load(detailHtml);

      // Collect description and requirements from white-blocks
      let cleanDesc = '';
      detail$('.white-block').each((_, blockEl) => {
        const text = detail$(blockEl).text().trim();
        if (text.startsWith('تفاصيل الوظيفة') || text.startsWith('متطلبات الوظيفة')) {
          cleanDesc += text + '\n\n';
        }
      });

      // Parse salary
      let budgetMin: number | undefined;
      let budgetMax: number | undefined;
      let budgetText: string | undefined;

      const salaryBlock = detail$('.white-block').filter((_, blockEl) => {
        return detail$(blockEl).text().includes('الراتب الأساسي');
      });

      if (salaryBlock.length > 0) {
        const salaryText = salaryBlock.text().replace(/\s+/g, ' ').trim();
        if (!salaryText.includes('غير معلن')) {
          budgetText = salaryText;
          const nums = salaryText.match(/\d+/g);
          if (nums && nums.length >= 2) {
            budgetMin = Number(nums[0]);
            budgetMax = Number(nums[1]);
          } else if (nums && nums.length === 1) {
            budgetMin = Number(nums[0]);
          }
        }
      }

      const job: JobPostInput = {
        source: 'forasna',
        sourceProjectId: item.sourceProjectId,
        title: item.title,
        url: item.url,
        description: cleanDesc,
        rawText: cleanDesc,
        category: 'Software Development',
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
      logEvent('error', 'forasna_detail_error', { url: item.url, error: err.message });
    }
  }

  return jobs;
}
