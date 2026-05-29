import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, fetchHtml, sleep, logEvent } from './index.js'
import { prisma } from './db.js'
import * as cheerio from 'cheerio'

export async function scrapeWuzzufSource(source: SourceConfig): Promise<JobPostInput[]> {
  const listHtml = await fetchHtml(source.url);
  const $ = cheerio.load(listHtml);

  const listings: { title: string; url: string; sourceProjectId: string }[] = [];

  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (href.includes('/jobs/p/') || href.includes('/internship/')) {
      const match = href.match(/\/(?:jobs\/p|internship)\/([a-zA-Z0-9]+)-/);
      const projectId = match?.[1] || '';
      if (projectId) {
        // Resolve absolute URL
        const fullUrl = new URL(href, source.baseUrl).href;
        // Avoid duplicate links in same page
        if (!listings.some(l => l.sourceProjectId === projectId)) {
          listings.push({
            title: text || 'Job Position',
            url: fullUrl,
            sourceProjectId: projectId
          });
        }
      }
    }
  });

  logEvent('info', 'wuzzuf_listings_parsed', { count: listings.length });

  if (listings.length === 0) {
    return [];
  }

  // Filter out existing ones
  const existingPosts = await prisma.jobPost.findMany({
    where: {
      source: 'wuzzuf',
      sourceProjectId: { in: listings.map(l => l.sourceProjectId) }
    },
    select: { sourceProjectId: true }
  });

  const existingIds = new Set(existingPosts.map(p => p.sourceProjectId));
  const newListings = listings.filter(l => !existingIds.has(l.sourceProjectId));

  logEvent('info', 'wuzzuf_new_listings', { count: newListings.length });

  const jobs: JobPostInput[] = [];

  for (const item of newListings) {
    await sleep(500); // polite delay
    try {
      const detailHtml = await fetchHtml(item.url);
      const detail$ = cheerio.load(detailHtml);

      // Extract details from SSR state object
      const scriptText = detail$('script').first().text().trim();
      const stateMatch = scriptText.match(/Wuzzuf\.initialStoreState\s*=\s*(\{[\s\S]*?\});\s*Wuzzuf\./);
      
      let title = item.title;
      let cleanDesc = '';
      let skills: string[] = [];
      let budgetMin: number | undefined;
      let budgetMax: number | undefined;
      let budgetText: string | undefined;

      if (stateMatch && stateMatch[1]) {
        try {
          const stateObj = JSON.parse(stateMatch[1]);
          const jobCollection = stateObj.entities?.job?.collection || {};
          const jobId = Object.keys(jobCollection)[0];
          if (jobId) {
            const jobData = jobCollection[jobId];
            if (jobData && jobData.attributes) {
              const attrs = jobData.attributes;
              if (attrs.title) title = attrs.title;

              // Load description and requirements and strip HTML tags
              const descHtml = attrs.description || '';
              const reqHtml = attrs.requirements || '';
              
              const descText = cheerio.load(descHtml).text().trim();
              const reqText = cheerio.load(reqHtml).text().trim();
              cleanDesc = `${descText}\n\nRequirements:\n${reqText}`.trim();

              // Extract skills/keywords
              if (Array.isArray(attrs.keywords)) {
                skills = attrs.keywords.map((k: any) => k.name).filter(Boolean);
              }

              // Extract salary
              if (attrs.salary) {
                if (attrs.salary.min !== null) budgetMin = attrs.salary.min;
                if (attrs.salary.max !== null) budgetMax = attrs.salary.max;
                if (attrs.salary.currency) {
                  budgetText = `${budgetMin || ''} - ${budgetMax || ''} ${attrs.salary.currency}`.trim();
                }
              }
            }
          }
        } catch (jsonErr: any) {
          logEvent('warn', 'wuzzuf_json_parse_failed', { url: item.url, error: jsonErr.message });
        }
      }

      // Fallback selector-based parsing if JSON extraction failed
      if (!cleanDesc) {
        detail$('style').remove();
        detail$('script').remove();

        let rawDesc = '';
        detail$('section').each((_, secEl) => {
          const text = detail$(secEl).text().trim();
          if (
            text.includes('Job Description') ||
            text.includes('Job Requirements') ||
            text.includes('وصف الوظيفة') ||
            text.includes('متطلبات الوظيفة')
          ) {
            rawDesc += text + '\n\n';
          }
        });
        cleanDesc = rawDesc.trim();
      }

      const job: JobPostInput = {
        source: 'wuzzuf',
        sourceProjectId: item.sourceProjectId,
        title,
        url: item.url,
        description: cleanDesc,
        rawText: cleanDesc,
        category: 'Software Development',
        publishedAt: new Date(),
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
      logEvent('error', 'wuzzuf_detail_error', { url: item.url, error: err.message });
    }
  }

  return jobs;
}
