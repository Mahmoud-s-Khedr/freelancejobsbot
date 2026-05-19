import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractMostaqlProjectId, parseMostaqlListing, parseMostaqlProjectDetail } from '../src/mostaql.js'
import { formatTelegramMessage } from '../src/format.js'

test('extractMostaqlProjectId parses valid project URLs', () => {
  assert.equal(extractMostaqlProjectId('https://mostaql.com/project/1241427-sample'), '1241427')
  assert.equal(extractMostaqlProjectId('https://mostaql.com/project/1241427'), '1241427')
  assert.equal(extractMostaqlProjectId('https://mostaql.com/projects?page=2'), null)
})

test('parseMostaqlListing extracts rows from project table', () => {
  const html = readFileSync('tests/fixtures/mostaql-listing.html', 'utf8')
  const items = parseMostaqlListing(html, 'https://mostaql.com')

  assert.equal(items.length, 2)
  const first = items[0]
  assert.ok(first)
  assert.equal(first.sourceProjectId, '1241427')
  assert.equal(first.title, 'حماية موقعي من الهجمات في cloudflare')
  assert.match(first.url, /1241427/)
  assert.match(first.publishedRelativeText ?? '', /ساعتين/)
  assert.match(first.bidCountText ?? '', /6 عروض/)
})

test('parseMostaqlProjectDetail extracts structured fields and skills', () => {
  const html = readFileSync('tests/fixtures/mostaql-detail.html', 'utf8')
  const detail = parseMostaqlProjectDetail(html)

  assert.equal(detail.title, 'حماية موقعي من الهجمات في cloudflare')
  assert.equal(detail.status, 'مفتوح')
  assert.equal(detail.category, 'برمجة، تطوير المواقع والتطبيقات')
  assert.equal(detail.budgetMin, 25)
  assert.equal(detail.budgetMax, 50)
  assert.equal(detail.durationText, '2 يومين')
  assert.ok(detail.publishedAt instanceof Date)
  assert.ok((detail.skills ?? []).includes('أمن وحماية المواقع'))
})

test('formatTelegramMessage escapes HTML and respects size limit', () => {
  const msg = formatTelegramMessage({
    source: 'mostaql',
    title: '<script>alert(1)</script>',
    url: 'https://mostaql.com/project/1-test',
    description: 'a'.repeat(5000),
    category: 'dev',
    status: 'open',
    budgetText: '$25 - $50',
    durationText: '2 days',
    skills: ['x', 'y']
  })

  assert.ok(msg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(msg.length <= 4096)
})
