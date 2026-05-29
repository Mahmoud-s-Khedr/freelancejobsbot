import { scrapeUreedSource } from './ureed.js'
import { scrapeBaaeedSource } from './baaeed.js'
import { scrapeNafezlySource } from './nafezly.js'
import { scrapeBahrSource } from './bahr.js'
import { scrapeForasnaSource } from './forasna.js'
import { scrapeTanqeebSource } from './tanqeeb.js'
import { scrapeBaytSource } from './bayt.js'
import { scrapeWuzzufSource } from './wuzzuf.js'
import type { SourceConfig } from './index.js'
import { logEvent } from './index.js'

async function runVerification() {
  const configs: SourceConfig[] = [
    {
      name: 'ureed',
      url: 'https://app.ureed.com/find-projects?keyword=',
      baseUrl: 'https://app.ureed.com'
    },
    {
      name: 'baaeed',
      url: 'https://baaeed.com/remote-jobs',
      baseUrl: 'https://baaeed.com'
    },
    {
      name: 'nafezly',
      url: 'https://nafezly.com/projects',
      baseUrl: 'https://nafezly.com'
    },
    {
      name: 'bahr',
      url: 'https://bahr.sa/projects?sortBy=publishDate_DESC',
      baseUrl: 'https://bahr.sa'
    },
    {
      name: 'forasna',
      url: 'https://forasna.com/%D9%88%D8%B8%D8%A7%D8%A6%D9%81-%D8%AE%D8%A7%D9%84%D9%8A%D8%A9?query=%D9%85%D8%B7%D9%88%D8%B1',
      baseUrl: 'https://forasna.com'
    },
    {
      name: 'tanqeeb',
      url: 'https://egypt.tanqeeb.com/ar/jobs/search?keywords=%D9%85%D8%B7%D9%88%D8%B1&country=-1&state=0&category=-1&workplace=0&search_period=0&lang=all&page_no=1&refine%5Bonly_featured%5D=1',
      baseUrl: 'https://egypt.tanqeeb.com'
    },
    {
      name: 'bayt',
      url: 'https://www.bayt.com/ar/international/jobs/',
      baseUrl: 'https://www.bayt.com'
    },
    {
      name: 'wuzzuf',
      url: 'https://wuzzuf.net/search/jobs?q=%D9%85%D8%B7%D9%88%D8%B1&a=hpb',
      baseUrl: 'https://wuzzuf.net'
    }
  ];

  console.log("=== STARTING VERIFICATION FOR NEW SCRAPERS ===");

  for (const config of configs) {
    console.log(`\n--- Testing source: ${config.name} ---`);
    try {
      let jobs: any[] = [];
      if (config.name === 'ureed') jobs = await scrapeUreedSource(config);
      else if (config.name === 'baaeed') jobs = await scrapeBaaeedSource(config);
      else if (config.name === 'nafezly') jobs = await scrapeNafezlySource(config);
      else if (config.name === 'bahr') jobs = await scrapeBahrSource(config);
      else if (config.name === 'forasna') jobs = await scrapeForasnaSource(config);
      else if (config.name === 'tanqeeb') jobs = await scrapeTanqeebSource(config);
      else if (config.name === 'bayt') jobs = await scrapeBaytSource(config);
      else if (config.name === 'wuzzuf') jobs = await scrapeWuzzufSource(config);

      console.log(`SUCCESS: Scraped ${jobs.length} jobs.`);
      if (jobs.length > 0) {
        const job = jobs[0];
        console.log(`First job sample:`);
        console.log(`  - Title: ${job.title}`);
        console.log(`  - URL: ${job.url}`);
        console.log(`  - Project ID: ${job.sourceProjectId}`);
        console.log(`  - Budget Min/Max: ${job.budgetMin} / ${job.budgetMax}`);
        console.log(`  - Budget Text: ${job.budgetText}`);
        console.log(`  - Skills: ${JSON.stringify(job.skills)}`);
        console.log(`  - Description (truncated): ${job.description?.slice(0, 150)}...`);
      }
    } catch (err: any) {
      console.error(`ERROR on source ${config.name}:`, err.message);
    }
  }

  console.log("\n=== VERIFICATION FINISHED ===");
}

runVerification().catch(console.error);
