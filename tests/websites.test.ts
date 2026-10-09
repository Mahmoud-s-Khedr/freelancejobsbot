import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  embeddedJson,
  parseIndeed,
  indeedDetail,
  parseWuzzuf,
  linkedinDetail,
  relativeDate,
  jobPostings,
  parseStructuredPage,
  blockedPage,
  siteJobId,
} from "../src/collection/websites/parsers.js";
import { collectWebsite } from "../src/collection/websites/collect.js";
import {
  allowedUrl,
  diagnosticHtml,
  profileLock,
} from "../src/collection/websites/browser.js";
import type { Target } from "../src/collection/types.js";
const fixture = (name: string) =>
  readFileSync(`tests/fixtures/websites/${name}.html`, "utf8");
const target = (provider: Target["provider"], url: string): Target => ({
  id: provider,
  provider,
  url,
  employer: "",
  entityIds: [],
  evidence: [],
  status: "enabled",
  pendingReason: null,
  attribution: provider,
  intervalHours: 1,
  restrictions: "",
});
const linkedinSelectors = JSON.parse(
  readFileSync("data/selectors/linkedin.json", "utf8"),
);
const linkedHtml = (id = "123") =>
  `<h1 class="t-24 t-bold"><a href="https://www.linkedin.com/jobs/view/${id}/">Software developer</a></h1><div class="topcard__org-name-link">Example</div><div id="job-details">Build APIs</div><span class="tvm__text--positive"><strong>2 days ago</strong></span>`;
const structured = (url: string) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@graph": [
      { "@type": "Organization", name: "Ignore" },
      {
        "@type": "JobPosting",
        title: "Software developer",
        url,
        description: "<p>Build React systems</p>",
        hiringOrganization: { name: "Example" },
        jobLocation: {
          address: { addressLocality: "Cairo", addressCountry: "Egypt" },
        },
        datePosted: "2026-10-01T12:00:00Z",
        baseSalary: {
          currency: "EGP",
          value: { minValue: 20000, maxValue: 40000, unitText: "MONTH" },
        },
      },
    ],
  })}</script>`;
test("RTJobs-derived Indeed fixture: stable identities, timestamps, snippets, detail recovery", () => {
  const inv = parseIndeed(fixture("indeed-listing"));
  assert.equal(inv.jobs.length, 15);
  assert.equal(inv.errors.length, 0);
  assert.ok(
    inv.jobs.every(
      (j) =>
        j.externalId &&
        j.title &&
        j.url.includes("?jk=") &&
        j.detailStatus === "fallback",
    ),
  );
  assert.ok(inv.jobs[0]!.publishedAt?.endsWith("Z"));
  const detail = indeedDetail(
    fixture("indeed-detail"),
    inv.jobs[0]!.externalId,
  );
  assert.ok(detail.description);
  assert.equal(detail.detailStatus, "full");
  assert.throws(
    () => embeddedJson('const data = {"x": "unterminated}', /const data = /),
    /Unbalanced/,
  );
  assert.deepEqual(
    embeddedJson(
      'data = {"x":"brace } and \\" quote","nested":{"a":1}};',
      /data = /,
    ),
    { x: 'brace } and " quote', nested: { a: 1 } },
  );
  assert.throws(
    () =>
      indeedDetail(
        '<script>window._initialData = {"hostQueryExecutionResult":{"data":{"jobData":{"results":[{"job":{"jobkey":"wrong","description":{"text":"Wrong job"}}}]}}}};</script>',
        "expected",
      ),
    /mismatch/,
  );
});
test("RTJobs-derived WUZZUF fixture: structured enrichment without invented timezone", () => {
  const inv = parseWuzzuf(fixture("wuzzuf-listing"));
  assert.equal(inv.jobs.length, 15);
  assert.equal(inv.errors.length, 0);
  assert.ok(inv.jobs[0]!.description?.includes("Qualifications"));
  assert.ok(inv.jobs[0]!.seniority);
  assert.equal(inv.jobs[0]!.publishedAt, undefined);
  assert.equal(inv.jobs[0]!.timestampSemantics, "unknown");
  assert.throws(() => parseWuzzuf("<html>redesign</html>"), /Missing/);
});
test("LinkedIn verifies detail identity and labels relative dates as estimates", () => {
  const job = linkedinDetail(
    linkedHtml(),
    "123",
    linkedinSelectors,
    new Date("2026-10-07T12:00:00Z"),
  );
  assert.equal(job.employer, "Example");
  assert.equal(job.publishedAt, "2026-10-05T12:00:00.000Z");
  assert.equal(job.timestampSemantics, "estimated-relative-publication");
  assert.throws(
    () => linkedinDetail(linkedHtml("456"), "123", linkedinSelectors),
    /mismatch/,
  );
  assert.equal(relativeDate("recently posted", new Date()), undefined);
});
test("structured extraction supports Forasna, Bayt and Wellfound, including graphs and salary", () => {
  for (const [provider, url] of [
    ["forasna", "https://forasna.com/job/p/123-software"],
    ["bayt", "https://www.bayt.com/en/egypt/jobs/software-developer-123/"],
    ["wellfound", "https://wellfound.com/jobs/123-software"],
  ] as const) {
    const p = parseStructuredPage(provider, structured(url), url);
    assert.equal(p.jobs.length, 1);
    assert.equal(p.jobs[0]!.externalId, "123");
    assert.equal(p.jobs[0]!.budgetMin, 20000);
    assert.equal(p.jobs[0]!.compensationPeriod, "MONTH");
    assert.deepEqual(p.jobs[0]!.locations, ["Cairo, Egypt"]);
  }
  assert.equal(
    siteJobId(
      "forasna",
      "https://forasna.com/job/p/%D9%85%D9%87%D9%86%D8%AF%D8%B3-443062",
    ),
    "443062",
  );
  assert.equal(
    jobPostings(
      '<script type="application/ld+json">{"@type":"Organization"}</script>',
    ).length,
    0,
  );
});
test("Indeed caps details, retains fallback jobs, and prioritizes recovery next run", async () => {
  let details = 0;
  const read = async (url: string) =>
    url.includes("/jobs?")
      ? fixture("indeed-listing")
      : (details++, fixture("indeed-detail"));
  const t = target("indeed", "https://eg.indeed.com/jobs?q=software");
  const first = await collectWebsite(t, { read });
  assert.equal(first.jobs.length, 15);
  assert.equal(details, 10);
  assert.equal(first.complete, true);
  const full = new Set(
    first.jobs
      .filter((j) => j.detailStatus === "full")
      .map((j) => j.externalId),
  );
  const second = await collectWebsite(t, { read }, full);
  assert.ok(
    second.jobs
      .filter((j) => !full.has(j.externalId))
      .every((j) => j.detailStatus === "full"),
  );
});
test("blocked and repeated pages remain incomplete while retaining observed jobs", async () => {
  const t = target(
    "wuzzuf",
    "https://wuzzuf.net/search/jobs?q=software&start=0",
  );
  const repeated = await collectWebsite(t, {
    read: async () => fixture("wuzzuf-listing"),
  });
  assert.equal(repeated.jobs.length, 15);
  assert.equal(repeated.complete, false);
  assert.match(repeated.errors.join(" "), /Repeated/);
  let count = 0;
  const blocked = await collectWebsite(t, {
    read: async () =>
      count++ ? "<title>Security Check</title>" : fixture("wuzzuf-listing"),
  });
  assert.equal(blocked.jobs.length, 15);
  assert.equal(blocked.complete, false);
  const empty = await collectWebsite(
    target("wellfound", "https://wellfound.com/jobs"),
    { read: async () => "<html>redesign</html>" },
  );
  assert.equal(empty.complete, false);
});
test("structured collectors follow listing links and retain jobs across interrupted pagination", async () => {
  const t = target("bayt", "https://www.bayt.com/en/egypt/jobs/");
  const jobUrl = "https://www.bayt.com/en/egypt/jobs/software-123/";
  const inv = await collectWebsite(t, {
    read: async (url) =>
      url === t.url
        ? `<a href="${jobUrl}">Software developer</a><a rel="next" href="?page=2">Next</a>`
        : url === jobUrl
          ? structured(jobUrl)
          : "<title>Access denied</title>",
  });
  assert.equal(inv.jobs.length, 1);
  assert.equal(inv.jobs[0]!.detailStatus, "full");
  assert.equal(inv.complete, false);
});
test("LinkedIn collection retains failed details as fallback and does not accept unverified emptiness", async () => {
  const inv = await collectWebsite(
    target("linkedin", "https://www.linkedin.com/jobs/search/"),
    {
      read: async () => "",
      linkedinDetails: async () => [
        {
          id: "123",
          html: "",
          title: "Software developer",
          company: "Example",
          location: "Egypt",
        },
      ],
    },
  );
  assert.equal(inv.jobs.length, 1);
  assert.equal(inv.jobs[0]!.detailStatus, "fallback");
  assert.equal(inv.complete, false);
});
test("provider boundaries, diagnostics and profile locks", async () => {
  assert.equal(allowedUrl("indeed", "https://eg.indeed.com/jobs"), true);
  assert.equal(
    allowedUrl("indeed", "https://indeed.com.evil.test/jobs"),
    false,
  );
  assert.equal(
    allowedUrl("indeed", "https://user:pass@indeed.com/jobs"),
    false,
  );
  assert.equal(blockedPage('<input type="password">'), true);
  assert.equal(
    blockedPage(fixture("linkedin-guest") + '<input type="password">'),
    false,
  );
  assert.equal(
    blockedPage(
      structured("https://forasna.com/job/p/123-software") +
        '<input type="password">',
    ),
    false,
  );
  assert.equal(
    blockedPage(fixture("linkedin-guest"), "https://www.linkedin.com/authwall"),
    true,
  );
  const safe = diagnosticHtml(
    '<script>token</script><form><input value="secret"></form><p data-token="hidden">Job</p>',
  );
  assert.ok(
    !safe.includes("secret") &&
      !safe.includes("hidden") &&
      !safe.includes("token"),
  );
  const dir = mkdtempSync(join(tmpdir(), "profile-lock-"));
  try {
    const unlock = await profileLock(dir);
    await assert.rejects(profileLock(dir), /already in use/);
    await unlock();
    const again = await profileLock(dir);
    await again();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LinkedIn public cards preserve IDs and dates; blocked details retain bounded inventory", async () => {
  const { parseLinkedInGuest, linkedinGuestDetail } =
    await import("../src/collection/websites/parsers.js");
  const parsed = parseLinkedInGuest(fixture("linkedin-guest"));
  assert.equal(parsed.jobs.length, 2);
  assert.ok(parsed.jobs.every((j) => j.externalId && j.title && j.employer));
  const first = parsed.jobs[0]!;
  const detail = `<link rel="canonical" href="${first.url}"><div class="show-more-less-html__markup"><p>Build APIs</p></div>`;
  assert.equal(
    linkedinGuestDetail(detail, first.externalId).detailStatus,
    "full",
  );
  assert.throws(() => linkedinGuestDetail(detail, "wrong"), /mismatch/);
  const t = target(
    "linkedin",
    "https://www.linkedin.com/jobs/search/?keywords=software",
  );
  const inv = await collectWebsite(t, {
    read: async (url) =>
      url === t.url
        ? fixture("linkedin-guest")
        : url === first.url
          ? detail
          : "<title>Access denied</title>",
  });
  assert.equal(inv.jobs.length, 2);
  assert.equal(inv.complete, true);
  assert.equal(inv.jobs[0]!.detailStatus, "full");
  assert.equal(inv.jobs[1]!.detailStatus, "fallback");
  assert.ok(inv.errors.length);
});
test("Forasna missing JSON-LD description is enriched from labelled requirements", () => {
  const url = "https://forasna.com/job/p/example-443062";
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer","identifier":{"value":"443062"}}</script><ul class="job-requirements-cols"><li><p class="title-lable">Experience</p><p class="item-info">3 years</p></li></ul>`;
  const job = parseStructuredPage("forasna", html, url).jobs[0]!;
  assert.equal(job.detailStatus, "full");
  assert.equal(job.description, "Experience: 3 years");
});

test("repeated structured pages are incomplete even if pagination URLs change", async () => {
  const t = target("wellfound", "https://wellfound.com/jobs");
  const jobUrl = "https://wellfound.com/jobs/123-software";
  const inv = await collectWebsite(t, {
    read: async (url) =>
      url === jobUrl
        ? structured(jobUrl)
        : `<a href="${jobUrl}">Software developer</a><a rel="next" href="?page=${url.includes("page=") ? 3 : 2}">Next</a>`,
  });
  assert.equal(inv.jobs.length, 1);
  assert.equal(inv.complete, false);
  assert.match(inv.errors.join(" "), /Repeated structured/);
});
test("website opt-in and search overrides do not mutate the tracked registry", async () => {
  const { registry } = await import("../src/collection/registry.js");
  const before = readFileSync("data/source-registry.json", "utf8");
  const priorEnabled = process.env.INDEED_ENABLED,
    priorUrl = process.env.INDEED_SEARCH_URL;
  try {
    process.env.INDEED_ENABLED = "true";
    process.env.INDEED_SEARCH_URL = "https://eg.indeed.com/jobs?q=typescript";
    const r = await registry();
    const t = r.targets.find((t) => t.id === "indeed")!;
    assert.equal(t.status, "enabled");
    assert.equal(t.url, process.env.INDEED_SEARCH_URL);
    process.env.INDEED_ENABLED = "false";
    assert.equal(
      (await registry()).targets.find((t) => t.id === "indeed")!.status,
      "disabled",
    );
    assert.equal(readFileSync("data/source-registry.json", "utf8"), before);
  } finally {
    if (priorEnabled === undefined) delete process.env.INDEED_ENABLED;
    else process.env.INDEED_ENABLED = priorEnabled;
    if (priorUrl === undefined) delete process.env.INDEED_SEARCH_URL;
    else process.env.INDEED_SEARCH_URL = priorUrl;
  }
});

test("authenticated LinkedIn collector passes its remaining detail budget and recovery priorities", async () => {
  const prior = process.env.LINKEDIN_MAX_DETAILS;
  process.env.LINKEDIN_MAX_DETAILS = "2";
  try {
    let budget: number | undefined;
    const full = new Set(["123"]);
    const inv = await collectWebsite(
      target("linkedin", "https://www.linkedin.com/jobs/search/"),
      {
        read: async () => "<html>Authenticated search</html>",
        linkedinDetails: async (_url, _selectors, max, priorities) => {
          budget = max;
          assert.ok(priorities?.has("123"));
          return [
            {
              id: "123",
              html: linkedHtml(),
              title: "Software developer",
              company: "Example",
              location: "Egypt",
            },
          ];
        },
      },
      full,
    );
    assert.equal(budget, 2);
    assert.equal(inv.jobs.length, 1);
  } finally {
    if (prior === undefined) delete process.env.LINKEDIN_MAX_DETAILS;
    else process.env.LINKEDIN_MAX_DETAILS = prior;
  }
});

test("structured collectors prioritize missing details ahead of known full jobs", async () => {
  for (const [site, search, first, second] of [
    ["forasna", "https://forasna.com/", "https://forasna.com/job/p/123-software", "https://forasna.com/job/p/456-software"],
    ["bayt", "https://www.bayt.com/en/egypt/jobs/", "https://www.bayt.com/en/egypt/jobs/software-123/", "https://www.bayt.com/en/egypt/jobs/software-456/"],
    ["wellfound", "https://wellfound.com/jobs", "https://wellfound.com/jobs/123-software", "https://wellfound.com/jobs/456-software"],
  ] as const) {
    const name = `${site.toUpperCase()}_MAX_DETAILS`;
    const prior = process.env[name];
    process.env[name] = "1";
    try {
      const reads: string[] = [];
      const inv = await collectWebsite(target(site, search), {
        read: async (url) => {
          reads.push(url);
          return url === search
            ? `<a href="${first}">Software developer</a><a href="${second}">Software developer</a>`
            : structured(url);
        },
      }, new Set(["123"]));
      assert.deepEqual(reads, [search, second], site);
      assert.equal(inv.jobs.find((j) => j.externalId === "456")?.detailStatus, "full", site);
      assert.equal(inv.jobs.find((j) => j.externalId === "123")?.detailStatus, "fallback", site);
    } finally {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
});
