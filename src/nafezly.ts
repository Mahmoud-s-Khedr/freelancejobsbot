import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, fetchHtml, sleep, logEvent } from './index.js'
import { prisma } from './db.js'
import * as cheerio from 'cheerio'

export async function scrapeNafezlySource(source: SourceConfig): Promise<JobPostInput[]> {
  const listHtml = await fetchHtml(source.url);
  const $ = cheerio.load(listHtml);

  const listings: { title: string; url: string; sourceProjectId: string }[] = [];

  $('.project-box').each((_, el) => {
    const titleEl = $(el).find('a.text-truncate');
    if (titleEl.length > 0) {
      const title = titleEl.text().trim();
      const href = titleEl.attr('href') || '';
      if (href) {
        // Nafezly project URLs are like https://nafezly.com/project/48562-slug
        // Extract project ID (e.g. 48562)
        const match = href.match(/\/project\/(\d+)(?:-|$)/);
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

  logEvent('info', 'nafezly_listings_parsed', { count: listings.length });

  if (listings.length === 0) {
    return [];
  }

  // Filter out existing ones
  const existingPosts = await prisma.jobPost.findMany({
    where: {
      source: 'nafezly',
      sourceProjectId: { in: listings.map(l => l.sourceProjectId) }
    },
    select: { sourceProjectId: true }
  });

  const existingIds = new Set(existingPosts.map(p => p.sourceProjectId));
  const newListings = listings;

  logEvent('info', 'nafezly_new_listings', { count: newListings.length });

  const jobs: JobPostInput[] = [];

  for (const item of newListings) {
    await sleep(500); // polite delay
    try {
      const detailHtml = await fetchHtml(item.url);
      const detail$ = cheerio.load(detailHtml);

      // Description is inside h2.naskh
      const cleanDesc = detail$('h2.naskh').text().trim();

      // Sidebar details
      let budgetMin: number | undefined;
      let budgetMax: number | undefined;
      let budgetText: string | undefined;
      const skills: string[] = [];

      detail$('div').each((_, el) => {
        const text = detail$(el).text().trim();
        if (text === 'الميزانية') {
          const val = detail$(el).next().text().trim();
          if (val) {
            budgetText = val;
            const nums = val.match(/\d+/g);
            if (nums && nums.length >= 2) {
              budgetMin = Number(nums[0]);
              budgetMax = Number(nums[1]);
            } else if (nums && nums.length === 1) {
              budgetMin = Number(nums[0]);
            }
          }
        }
      });

      // Extract skills
      detail$('a[href*="/projects/skill/"]').each((_, el) => {
        const skill = detail$(el).text().trim();
        if (skill) {
          skills.push(skill);
        }
      });

      const job: JobPostInput = {
        source: 'nafezly',
        sourceProjectId: item.sourceProjectId,
        title: item.title,
        url: item.url,
        description: cleanDesc,
        rawText: cleanDesc,

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
      logEvent('error', 'nafezly_detail_error', { url: item.url, error: err.message });
      jobs.push({source:'nafezly', ...item, detailStatus:'fallback'});
    }
  }

  return jobs;
}
