import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, fetchHtml, sleep, logEvent, getEnvInt } from './index.js'
import { prisma } from './db.js'
import * as cheerio from 'cheerio'

export async function scrapeBaaeedSource(source: SourceConfig): Promise<JobPostInput[]> {
  const listHtml = await fetchHtml(source.url);
  const $ = cheerio.load(listHtml);

  const listings: { title: string; url: string; sourceProjectId: string }[] = [];

  $('tr').each((_, el) => {
    const titleEl = $(el).find('h3.card-title a');
    if (titleEl.length > 0) {
      const title = titleEl.text().trim();
      const relativeUrl = titleEl.attr('href') || '';
      if (relativeUrl) {
        const fullUrl = new URL(relativeUrl, source.baseUrl).href;
        const parts = fullUrl.split('/');
        const slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
        if (slug) {
          listings.push({
            title,
            url: fullUrl,
            sourceProjectId: slug
          });
        }
      }
    }
  });

  logEvent('info', 'baaeed_listings_parsed', { count: listings.length });

  if (listings.length === 0) {
    return [];
  }

  // Filter out existing ones
  const existingPosts = await prisma.jobPost.findMany({
    where: {
      source: 'baaeed',
      sourceProjectId: { in: listings.map(l => l.sourceProjectId) }
    },
    select: { sourceProjectId: true }
  });

  const existingIds = new Set(existingPosts.map(p => p.sourceProjectId));
  const newListings = listings.filter(l => !existingIds.has(l.sourceProjectId));

  logEvent('info', 'baaeed_new_listings', { count: newListings.length });

  const jobs: JobPostInput[] = [];

  const requestDelayMs = getEnvInt('BAAEED_REQUEST_DELAY_MS', 2000)

  for (const item of newListings) {
    await sleep(requestDelayMs)
    try {
      const detailHtml = await fetchHtml(item.url);
      const detail$ = cheerio.load(detailHtml);

      // Description is inside hidden input
      const descVal = detail$('input#read-only-description').attr('value') || '';
      const cleanDesc = descVal ? cheerio.load(descVal).text().trim() : '';

      // Sidebar details
      let budgetMin: number | undefined;
      let budgetMax: number | undefined;
      let budgetText: string | undefined;
      const skills: string[] = [];

      detail$('.object-card .attribute').each((_, attrEl) => {
        const name = detail$(attrEl).find('.attribute-name').text().trim();
        const val = detail$(attrEl).find('.attribute-value').text().trim();

        if (name.includes('مجال الراتب')) {
          budgetText = val;
          const nums = val.match(/\d+/g);
          if (nums && nums.length >= 2) {
            budgetMin = Number(nums[0]);
            budgetMax = Number(nums[1]);
          } else if (nums && nums.length === 1) {
            budgetMin = Number(nums[0]);
          }
        } else if (name.includes('المهارات')) {
          const lines = val.split('\n').map(l => l.trim()).filter(Boolean);
          skills.push(...lines);
        }
      });

      const job: JobPostInput = {
        source: 'baaeed',
        sourceProjectId: item.sourceProjectId,
        title: item.title,
        url: item.url,
        description: cleanDesc,
        rawText: cleanDesc,
        publishedAt: new Date(), // Baaeed relative dates can be defaulted to now
        skills,
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
      logEvent('error', 'baaeed_detail_error', { url: item.url, error: err.message });
    }
  }

  return jobs;
}
