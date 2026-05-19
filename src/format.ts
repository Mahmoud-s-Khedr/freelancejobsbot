const TELEGRAM_TEXT_LIMIT = 4096

export type TelegramJob = {
  source: string
  title: string
  url: string
  description?: string
  category?: string
  status?: string
  budgetText?: string
  durationText?: string
  publishedAt?: Date
  skills?: string[]
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function formatDate(date?: Date): string {
  return date ? date.toISOString() : 'N/A'
}

export function formatTelegramMessage(job: TelegramJob): string {
  const skillsText = job.skills?.length ? job.skills.join('، ') : 'N/A'
  const message = `
<b>New job from ${escapeHtml(job.source)}</b>

<b>${escapeHtml(job.title)}</b>

<b>Category:</b> ${escapeHtml(job.category ?? 'N/A')}
<b>Status:</b> ${escapeHtml(job.status ?? 'N/A')}
<b>Budget:</b> ${escapeHtml(job.budgetText ?? 'N/A')}
<b>Duration:</b> ${escapeHtml(job.durationText ?? 'N/A')}
<b>Published:</b> ${escapeHtml(formatDate(job.publishedAt))}
<b>Skills:</b> ${escapeHtml(skillsText)}

${job.description ? `${escapeHtml(job.description.slice(0, 1400))}\n\n` : ''}${escapeHtml(job.url)}
`.trim()

  return message.slice(0, TELEGRAM_TEXT_LIMIT)
}
