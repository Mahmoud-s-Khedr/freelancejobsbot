import { chromium } from 'playwright'
import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, logEvent } from './index.js'

export async function scrapeGoogleJobsSource(source: SourceConfig): Promise<JobPostInput[]> {
  const query = source.url || 'software developer remote';
  // Google Jobs search widget URL
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&ibp=htl;jobs`;

  logEvent('info', 'google_jobs_started', { query, url: searchUrl });

  let browser;
  try {
    // Launch headless chromium with settings to look like a standard desktop browser
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });

    const page = await context.newPage();
    
    // Navigate to Google homepage first to establish session/cookies
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'scratch/google_homepage.png' }).catch(() => {});

    // Navigate to Google Jobs search interface
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Save debug screenshot to see what's loaded
    await page.screenshot({ path: 'scratch/google_jobs_debug.png' }).catch(() => {});

    // Wait for the job listings to render (Google Jobs lists them under elements with jscontroller="qodLAe")
    const listSelector = 'div[jscontroller="qodLAe"]';
    try {
      await page.waitForSelector(listSelector, { timeout: 15000 });
    } catch (e) {
      logEvent('warn', 'google_jobs_no_listings_selector', { error: String(e) });
      // If the page structure loaded differently or standard listitems didn't appear, return empty list
      return [];
    }

    const listingElements = page.locator(listSelector);
    const count = await listingElements.count();
    logEvent('info', 'google_jobs_listings_found', { count });

    if (count === 0) {
      return [];
    }

    const jobs: JobPostInput[] = [];
    // Limit to the first 10 jobs to keep scraping execution quick and polite
    const limit = Math.min(count, 10);

    for (let i = 0; i < limit; i++) {
      const item = listingElements.nth(i);
      
      try {

        // Extract listing fields using robust multiple-selector fallbacks
        const title = await item.locator('.tNxQIb, [class*="vns7ce"], div[role="heading"], h3, .BjN57e').first().innerText({ timeout: 1000 }).catch(() => '');
        const company = await item.locator('.MKCbgd, [class*="ubtfgf"], .nJ1vXb, .QrSJ4e, .e10tge').first().innerText({ timeout: 1000 }).catch(() => '');
        const location = await item.locator('.FqK3wc, [class*="Q545Eb"], .mB14nd, .q07ZGc, .rcZ55').first().innerText({ timeout: 1000 }).catch(() => '');
        
        if (!title || !company) {
          logEvent('warn', 'google_jobs_missing_essential_listing_data', { index: i, title, company });
          continue;
        }

        // Click the job item to load the detailed description in the side pane
        await item.click({ force: true, timeout: 2000 }).catch(() => item.dispatchEvent('click'));
        // Wait for detail panel to fetch/render
        await page.waitForTimeout(600);

        // Extract description from the details pane
        const description = await page.locator('[jsname="QAWWu"], .OOyDTc, [class*="ybd1Lc"], .HBvzbc, .W77wGb').first().innerText({ timeout: 2000 }).catch(() => '');

        // Gather secondary metadata from active detail pane (like schedule type, e.g. "Full-time")
        const durationText = await page.locator('.Yf9oye, .fLsjxc, .Jmlvd, .Xb9hP, .qQ873c').first().innerText({ timeout: 1000 }).catch(() => undefined);

        // Attempt to find direct external apply links (e.g. "Apply on LinkedIn", "Apply on Glassdoor")
        let applyUrl = '';
        const applyLinkLocator = page.locator('a.brKmxb, .IjY5Tc a, a[role="button"]:has-text("Apply"), a[class*="apply"], a.eZ3g5b');
        const applyLinkCount = await applyLinkLocator.count();
        if (applyLinkCount > 0) {
          const href = await applyLinkLocator.first().getAttribute('href', { timeout: 1000 }).catch(() => null);
          if (href) {
            applyUrl = href;
          }
        }

        // Build a deterministic base64 hash of the title & company as the unique projectId
        const sourceProjectId = Buffer.from(`${title.trim()}-${company.trim()}`).toString('base64').replace(/=/g, '');

        // Fallback job URL if direct apply URL wasn't found
        const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&ibp=htl;jobs#fpstate=tldetail&htidocid=${sourceProjectId}`;
        const finalUrl = applyUrl || fallbackUrl;

        const job: JobPostInput = {
          source: 'google_jobs',
          sourceProjectId,
          title: `${title} at ${company}`,
          url: finalUrl,
          description: description || 'No description provided.',
          rawText: `Company: ${company}\nLocation: ${location}\nDuration: ${durationText || 'N/A'}\n\n${description}`,
          category: 'Development/Remote',
          publishedAt: new Date(),
          detailStatus: 'full'
        };

        if (durationText) {
          job.durationText = durationText;
        }

        job.listingHash = buildListingHash(job);
        job.detailHash = buildDetailHash(job);
        job.contentHash = buildContentHash(job);

        jobs.push(job);
      } catch (itemError: any) {
        logEvent('warn', 'google_jobs_item_parse_failed', { index: i, error: itemError.message });
      }
    }

    return jobs;
  } catch (err: any) {
    logEvent('error', 'google_jobs_scraper_failed', { error: err.message });
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
