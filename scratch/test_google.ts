import { scrapeGoogleJobsSource } from '../src/google_jobs.js'

async function run() {
  console.log('Starting Google Jobs scraper test run...');
  const mockSource = {
    name: 'google_jobs' as const,
    url: 'react developer remote',
    baseUrl: 'https://google.com'
  };

  try {
    const jobs = await scrapeGoogleJobsSource(mockSource);
    console.log(`Scraper execution finished. Found ${jobs.length} jobs.`);
    
    if (jobs.length > 0 && jobs[0]) {
      console.log('--- First Job Sample ---');
      const sample = jobs[0];
      console.log(`Title: ${sample.title}`);
      console.log(`URL: ${sample.url}`);
      console.log(`Duration/Type: ${sample.durationText}`);
      console.log(`Description Snippet: ${sample.description?.slice(0, 300)}...`);
      console.log('------------------------');
    }
  } catch (error) {
    console.error('Test execution failed:', error);
  }
}

run();
