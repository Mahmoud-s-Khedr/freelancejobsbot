import { isTechJob, DEFAULT_TECH_KEYWORDS_EN, DEFAULT_TECH_KEYWORDS_AR } from './src/filter.js';
import * as fs from 'fs';

const bahrData = JSON.parse(fs.readFileSync('./scraped_pages/bahr-listing.json', 'utf8'));
const recruitments = bahrData.data?.recruitments || [];

console.log('Testing Bahr jobs matching filter:');
for (const item of recruitments) {
  if (!item.project) continue;
  const skillsList = Array.isArray(item.skills)
    ? item.skills.map((s: any) => s.nameEn || s.nameAr).filter(Boolean)
    : [];
  const categoryName = item.project.category?.nameEn || item.project.category?.nameAr || '';
  const job = {
    source: 'bahr',
    title: item.project.title || '',
    description: item.project.description || '',
    rawText: item.project.description || '',
    category: categoryName,
    skills: skillsList
  };

  const matched = isTechJob(job);
  if (matched) {
    console.log(`\nMatched Job: "${job.title}" (Category: ${job.category})`);
    
    // Find which keyword matched
    const combinedText = [
      job.title,
      job.description,
      job.rawText,
      job.category,
      skillsList.join(' ')
    ].join('\n').toLowerCase();

    const matchedEn = DEFAULT_TECH_KEYWORDS_EN.filter(kw => {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const isStandard = /^[a-zA-Z0-9]+$/.test(kw);
      const regex = isStandard ? new RegExp(`\\b${escaped}\\b`, 'i') : new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:$|[^a-zA-Z0-9])`, 'i');
      return regex.test(combinedText);
    });

    const matchedAr = DEFAULT_TECH_KEYWORDS_AR.filter(kw => {
      return combinedText.includes(kw.toLowerCase());
    });

    console.log('  -> English Matches:', matchedEn);
    console.log('  -> Arabic Matches:', matchedAr);
  }
}
