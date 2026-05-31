import { scrapeSource, SOURCES, logEvent } from './index.js'

async function runVerification() {
  console.log('=== STARTING VERIFICATION FOR ALL SCRAPERS ===')

  for (const config of SOURCES) {
    console.log(`\n--- Testing source: ${config.name} ---`)
    try {
      const jobs = await scrapeSource(config)
      console.log(`SUCCESS: Scraped ${jobs.length} jobs.`)
      if (jobs.length > 0) {
        const job = jobs[0]!
        console.log('First job sample:')
        console.log(`  - Title: ${job.title}`)
        console.log(`  - URL: ${job.url}`)
        console.log(`  - Project ID: ${job.sourceProjectId}`)
        console.log(`  - Budget Min/Max: ${job.budgetMin} / ${job.budgetMax}`)
        console.log(`  - Budget Text: ${job.budgetText}`)
        console.log(`  - Skills: ${JSON.stringify(job.skills)}`)
        console.log(`  - Description (truncated): ${job.description?.slice(0, 150)}...`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`ERROR on source ${config.name}:`, msg)
      logEvent('error', 'verify_source_failed', { source: config.name, error: msg })
    }
  }

  console.log('\n=== VERIFICATION FINISHED ===')
}

runVerification().catch(console.error)
