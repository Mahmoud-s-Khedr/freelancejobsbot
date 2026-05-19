import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildKhamsatPageUrl, extractKhamsatRequestId, parseKhamsatDetail, parseKhamsatListing } from '../src/khamsat.js'

test('extractKhamsatRequestId parses valid request URLs', () => {
  assert.equal(extractKhamsatRequestId('https://khamsat.com/community/requests/788844-title'), '788844')
  assert.equal(extractKhamsatRequestId('https://khamsat.com/community/requests/788844'), '788844')
  assert.equal(extractKhamsatRequestId('https://khamsat.com/community/stories/123-title'), null)
})

test('parseKhamsatListing extracts listing rows with metadata', () => {
  const html = readFileSync('tests/fixtures/khamsat-listing.html', 'utf8')
  const items = parseKhamsatListing(html, 'https://khamsat.com')

  assert.equal(items.length, 2)
  const first = items[0]
  assert.ok(first)
  assert.equal(first.sourceProjectId, '788844')
  assert.equal(first.title, 'مطلوب مصمم فيديو بميزانية 10$')
  assert.equal(first.url, 'https://khamsat.com/community/requests/788844-%D9%85%D8%B7%D9%84%D9%88%D8%A8-%D9%85%D8%B5%D9%85%D9%85-%D9%81%D9%8A%D8%AF%D9%8A%D9%88-%D8%A8%D9%85%D9%8A%D8%B2%D8%A7%D9%86%D9%8A%D8%A9-10')
  assert.equal(first.authorName, 'محمود ا.')
  assert.equal(first.authorProfileUrl, 'https://khamsat.com/user/mahmoud635')
  assert.ok(first.publishedAt instanceof Date)
  assert.ok(first.latestInteractionAt instanceof Date)
})

test('parseKhamsatDetail extracts body, metadata and comment count', () => {
  const html = readFileSync('tests/fixtures/khamsat-detail.html', 'utf8')
  const detail = parseKhamsatDetail(
    html,
    'https://khamsat.com',
    'https://khamsat.com/community/requests/788844-%D9%85%D8%B7%D9%84%D9%88%D8%A8'
  )

  assert.equal(detail.sourceProjectId, '788844')
  assert.equal(detail.title, 'مطلوب مصمم فيديو بميزانية 10$')
  assert.match(detail.description ?? '', /فيديو اعلاني/)
  assert.equal(detail.category, 'طلبات الخدمات غير الموجودة')
  assert.equal(detail.authorName, 'محمود ا.')
  assert.equal(detail.authorProfileUrl, 'https://khamsat.com/user/mahmoud635')
  assert.equal(detail.commentCount, 32)
  assert.ok(detail.publishedAt instanceof Date)
})

test('buildKhamsatPageUrl builds next page URL from hidden page input', () => {
  const html = readFileSync('tests/fixtures/khamsat-listing.html', 'utf8')
  const page2 = buildKhamsatPageUrl(html, 'https://khamsat.com', 2)
  assert.equal(page2, 'https://khamsat.com/community/requests?page=2')
})

test('pagination page fingerprint detects repeated pages (no-new-ids guard)', () => {
  const html = readFileSync('tests/fixtures/khamsat-listing.html', 'utf8')
  const page1 = parseKhamsatListing(html, 'https://khamsat.com')
  const page2 = parseKhamsatListing(html, 'https://khamsat.com')

  const f1 = page1.map(r => r.sourceProjectId).sort().join(',')
  const f2 = page2.map(r => r.sourceProjectId).sort().join(',')
  assert.equal(f1, f2)
  assert.ok(f1.length > 0)
})

test('legacy URL lookup key remains stable for fallback matching', () => {
  const html = readFileSync('tests/fixtures/khamsat-listing.html', 'utf8')
  const [first] = parseKhamsatListing(html, 'https://khamsat.com')
  assert.ok(first)
  assert.equal(first.url, 'https://khamsat.com/community/requests/788844-%D9%85%D8%B7%D9%84%D9%88%D8%A8-%D9%85%D8%B5%D9%85%D9%85-%D9%81%D9%8A%D8%AF%D9%8A%D9%88-%D8%A8%D9%85%D9%8A%D8%B2%D8%A7%D9%86%D9%8A%D8%A9-10')
  assert.equal(first.sourceProjectId, '788844')
})
