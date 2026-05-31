import test from 'node:test'
import assert from 'node:assert/strict'
import { isTechJob } from '../src/filter.js'

test('isTechJob returns true for valid English tech keywords', () => {
  assert.ok(isTechJob({
    source: 'khamsat',
    title: 'Need a JavaScript developer',
    description: 'Looking for a senior react developer to build a web application.'
  }))

  assert.ok(isTechJob({
    source: 'mostaql',
    title: 'Python script for scraping',
    description: 'Scrape some products.'
  }))
})

test('isTechJob returns true for tech keywords with special characters', () => {
  assert.ok(isTechJob({
    source: 'khamsat',
    title: 'Looking for C++ coder',
    description: 'We need help with performance tuning.'
  }))

  assert.ok(isTechJob({
    source: 'khamsat',
    title: 'C# backend developer',
    description: 'ASP.NET project.'
  }))

  assert.ok(isTechJob({
    source: 'mostaql',
    title: 'Next.js application',
    description: 'Build a blog.'
  }))
})

test('isTechJob avoids false positives for partial word matches in English', () => {
  // 'happy' contains 'app', but should not match
  assert.equal(isTechJob({
    source: 'khamsat',
    title: 'I am happy to translate files',
    description: 'Translation job details.'
  }), false)

  // 'apply' contains 'app', but should not match
  assert.equal(isTechJob({
    source: 'khamsat',
    title: 'Please apply here',
    description: 'Marketing campaign.'
  }), false)

  // 'cats' contains 'ts' (typescript), but should not match
  assert.equal(isTechJob({
    source: 'khamsat',
    title: 'Funny cats video editor',
    description: 'Edit a video about cats.'
  }), false)
})

test('isTechJob returns true for valid Arabic tech keywords and variations', () => {
  // Substring match
  assert.ok(isTechJob({
    source: 'khamsat',
    title: 'مطلوب مبرمج لإنشاء بوت تليجرام',
    description: 'بوت بسيط يرسل تنبيهات.'
  }))

  // With prefix "الـ"
  assert.ok(isTechJob({
    source: 'khamsat',
    title: 'تصميم وبرمجة المواقع الإلكترونية',
    description: 'تطوير موقع وردبريس.'
  }))
})

test('isTechJob returns false for non-tech projects', () => {
  assert.equal(isTechJob({
    source: 'khamsat',
    title: 'مطلوب مترجم من الإنجليزية للعربية',
    description: 'ترجمة مقال من 1000 كلمة في مجال الطب.'
  }), false)

  assert.equal(isTechJob({
    source: 'mostaql',
    title: 'كتابة مقالات متوافقة مع السيو SEO',
    description: 'نحتاج لكاتب محتوى يكتب 10 مقالات.'
  }), false)

  assert.equal(isTechJob({
    source: 'khamsat',
    title: 'تصميم شعار احترافي لشركة مقاولات',
    description: 'لوجو مميز وبسيط.'
  }), false)
})

test('isTechJob auto-matches Mostaql tech categories', () => {
  assert.ok(isTechJob({
    source: 'mostaql',
    title: 'مشروع غامض بدون كلمات مفتاحية',
    category: 'برمجة، تطوير المواقع والتطبيقات'
  }))

  assert.ok(isTechJob({
    source: 'mostaql',
    title: 'تطوير نموذج ذكاء اصطناعي',
    category: 'ذكاء اصطناعي وتعلم الآلة'
  }))
})

test('isTechJob respects ENABLE_TECH_FILTER=false', () => {
  const original = process.env.ENABLE_TECH_FILTER
  process.env.ENABLE_TECH_FILTER = 'false'
  try {
    assert.ok(isTechJob({
      source: 'khamsat',
      title: 'مطلوب مترجم لغة فرنسية',
      description: 'لا يحتوي على أي كلمات برمجية.'
    }))
  } finally {
    if (original === undefined) delete process.env.ENABLE_TECH_FILTER
    else process.env.ENABLE_TECH_FILTER = original
  }
})

test('isTechJob supports additional keywords via environment variables', () => {
  const originalEn = process.env.ADDITIONAL_TECH_KEYWORDS_EN
  const originalAr = process.env.ADDITIONAL_TECH_KEYWORDS_AR
  
  process.env.ADDITIONAL_TECH_KEYWORDS_EN = 'rust,golang'
  process.env.ADDITIONAL_TECH_KEYWORDS_AR = 'سوليديتي'

  try {
    assert.ok(isTechJob({
      source: 'khamsat',
      title: 'Need a Rust developer',
      description: 'Systems programming.'
    }))

    assert.ok(isTechJob({
      source: 'khamsat',
      title: 'مطلوب خبير سوليديتي وكتابة العقود الذكية',
      description: 'برمجة بلوكشين.'
    }))
  } finally {
    if (originalEn === undefined) delete process.env.ADDITIONAL_TECH_KEYWORDS_EN
    else process.env.ADDITIONAL_TECH_KEYWORDS_EN = originalEn

    if (originalAr === undefined) delete process.env.ADDITIONAL_TECH_KEYWORDS_AR
    else process.env.ADDITIONAL_TECH_KEYWORDS_AR = originalAr
  }
})

test('isTechJob returns false for non-tech jobs', () => {
  assert.equal(isTechJob({
    source: 'mostaql',
    title: 'مطلوب باريستا لمطعم',
    description: 'خبرة في تحضير القهوة والمشروبات الساخنة والباردة.'
  }), false)

  assert.equal(isTechJob({
    source: 'khamsat',
    title: 'محاسب حديث التخرج',
    description: 'إدخال البيانات المالية ومراجعة الحسابات.'
  }), false)

  assert.equal(isTechJob({
    source: 'ureed',
    title: 'Truck driver needed',
    description: 'Deliver goods to various locations.'
  }), false)
})
