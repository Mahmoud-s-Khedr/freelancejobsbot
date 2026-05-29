import type { SourceConfig, JobPostInput } from './index.js'
import { buildListingHash, buildDetailHash, buildContentHash, logEvent } from './index.js'

export async function scrapeBahrSource(source: SourceConfig): Promise<JobPostInput[]> {
  const url = 'https://bahr.sa/api/recruitments?page=1&offset=20&sort=DESC&sortBy=project.publishDate&recruitmentStatus[]=Open';
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Bahr API returned status ${response.status}`);
  }

  const json = await response.json();
  const recruitments = json.data?.recruitments || [];

  const jobs: JobPostInput[] = [];

  for (const item of recruitments) {
    if (!item.id || !item.project) continue;

    const id = String(item.id);
    const projectUrl = `https://bahr.sa/projects/recruitments/${id}`;
    const project = item.project;

    // Skills
    const skillsList: string[] = Array.isArray(item.skills)
      ? item.skills.map((s: any) => s.nameEn || s.nameAr).filter(Boolean)
      : [];

    const categoryName = project.category?.nameEn || project.category?.nameAr || '';
    const budgetVal = item.budget ? Number(item.budget) : undefined;

    const job: JobPostInput = {
      source: 'bahr',
      sourceProjectId: id,
      title: project.title || '',
      url: projectUrl,
      description: project.description || '',
      rawText: project.description || '',
      category: categoryName,
      skills: skillsList,
      detailStatus: 'full'
    };

    if (project.publishDate) {
      job.publishedAt = new Date(project.publishDate.replace(' ', 'T') + 'Z');
    }
    if (budgetVal !== undefined) {
      job.budgetMin = budgetVal;
      job.budgetText = `${budgetVal} SAR`;
    }

    job.listingHash = buildListingHash(job);
    job.detailHash = buildDetailHash(job);
    job.contentHash = buildContentHash(job);

    jobs.push(job);
  }

  return jobs;
}
