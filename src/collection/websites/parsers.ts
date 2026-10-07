// Adapted from RTJobs b2c3da9; see docs/THIRD_PARTY_NOTICES.md.
import * as cheerio from "cheerio";
import { sanitizeHtml, date } from "../adapters.js";
import type { Job } from "../types.js";
export type Website =
  | "indeed"
  | "linkedin"
  | "wuzzuf"
  | "forasna"
  | "bayt"
  | "wellfound";
export type ParsedPage = {
  jobs: Job[];
  errors: string[];
  empty: boolean;
  next?: string;
};
export const string = (v: unknown): string =>
  typeof v === "string" ? v.trim() : "";
const clean = (v: unknown) => sanitizeHtml(string(v));
const https = (v: unknown): string | undefined => {
  try {
    const u = new URL(string(v));
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};
// Read JSON without evaluating website JavaScript. Escaped quotes/braces inside strings are significant.
export function embeddedJson(html: string, marker: RegExp): any {
  const match = marker.exec(html);
  if (!match) throw Error("Missing embedded inventory");
  const start = html.indexOf("{", match.index + match[0].length);
  if (start < 0) throw Error("Missing embedded JSON object");
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0)
      return JSON.parse(html.slice(start, i + 1));
  }
  throw Error("Unbalanced embedded JSON");
}
export function blockedPage(html: string, url = ""): boolean {
  const $ = cheerio.load(html);
  // Public job pages often contain an optional sign-in form. Its presence alone
  // does not make a verified public listing an authentication wall.
  const publicJobs =
    Boolean(
      $(
        ".base-card[data-entity-urn], .show-more-less-html__markup, #job-details",
      ).length,
    ) ||
    jobPostings(html).length > 0 ||
    /mosaic-provider-jobcards|window\.Wuzzuf\.initialStoreState/.test(html);
  return (
    /\/checkpoint|\/challenge|\/login(?:[/?]|$)|\/authwall/.test(url) ||
    /captcha|security check|just a moment|access denied|verify you are human|sign in.*linkedin/i.test(
      $("title").text(),
    ) ||
    Boolean($("#challenge-form, iframe[src*='captcha']").length) ||
    (Boolean($("input[type='password']").length) && !publicJobs)
  );
}
function salary(job: Job, value: any, currency?: unknown, period?: unknown) {
  if (!value || typeof value !== "object") return;
  const min = value.min ?? value.minValue ?? value.value;
  const max = value.max ?? value.maxValue ?? value.value;
  if (typeof min === "number" && Number.isFinite(min)) job.budgetMin = min;
  if (typeof max === "number" && Number.isFinite(max)) job.budgetMax = max;
  if (string(value.currency ?? currency))
    job.compensationCurrency = string(value.currency ?? currency);
  if (string(value.type ?? value.period ?? value.unitText ?? period))
    job.compensationPeriod = string(
      value.type ?? value.period ?? value.unitText ?? period,
    );
}
function workplace(location: string, explicit = ""): string {
  return /remote|عن بعد/i.test(explicit || location)
    ? "remote"
    : /hybrid/i.test(explicit)
      ? "hybrid"
      : /on.?site/i.test(explicit)
        ? "onsite"
        : "unknown";
}
export function parseIndeed(
  html: string,
  base = "https://eg.indeed.com",
): ParsedPage {
  const data = embeddedJson(
    html,
    /window\.mosaic\.providerData\[['"]mosaic-provider-jobcards['"]\]\s*=\s*/,
  );
  const rows = data?.metaData?.mosaicProviderJobCardsModel?.results;
  if (!Array.isArray(rows)) throw Error("Malformed Indeed inventory");
  const jobs: Job[] = [],
    errors: string[] = [];
  for (const r of rows) {
    const id = string(r?.jobkey),
      title = clean(r?.displayTitle || r?.normTitle || r?.title);
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || !title) {
      errors.push("Invalid Indeed identity/title");
      continue;
    }
    const location = clean(r.formattedLocation || r.jobLocationCity);
    const description = clean(r.snippet);
    const publishedAt =
      typeof (r.createDate ?? r.pubDate) === "number"
        ? date(r.createDate ?? r.pubDate)
        : undefined;
    const job: Job = {
      externalId: id,
      title,
      url: `${base}/viewjob?jk=${encodeURIComponent(id)}`,
      employer: clean(
        typeof r.company === "string" ? r.company : r.company?.name,
      ),
      description,
      locations: location ? [location] : [],
      geographicRestrictions: location ? [location] : [],
      workplaceModel: workplace(location, r.remoteLocation ? "remote" : ""),
      employmentType: Array.isArray(r.jobTypes)
        ? r.jobTypes.filter((x: unknown) => typeof x === "string").join(", ")
        : "",
      timestampSemantics: publishedAt ? "source-publication" : "unknown",
      detailStatus: "fallback",
      qualityEvidence: {
        provider: "indeed",
        sponsored: Boolean(r.sponsored),
        rawPublication: r.createDate ?? r.pubDate ?? null,
      },
    };
    if (publishedAt) job.publishedAt = publishedAt;
    salary(job, r.extractedSalary);
    if (r.expired === true) job.status = "expired";
    jobs.push(job);
  }
  return { jobs, errors, empty: rows.length === 0 };
}
export function parseLinkedInGuest(html: string): ParsedPage {
  const $ = cheerio.load(html),
    jobs: Job[] = [],
    errors: string[] = [];
  const cards = $(".base-card[data-entity-urn]");
  if (!cards.length) throw Error("Missing LinkedIn guest inventory");
  cards.each((_, el) => {
    const card = $(el),
      id = card.attr("data-entity-urn")?.match(/jobPosting:(\d+)/)?.[1];
    const title = clean(card.find(".base-search-card__title").text()),
      location = clean(card.find(".job-search-card__location").text());
    if (!id || !title) {
      errors.push("Invalid LinkedIn guest job identity/title");
      return;
    }
    const publishedAt = date(card.find("time[datetime]").attr("datetime"));
    const job: Job = {
      externalId: id,
      title,
      employer: clean(card.find(".base-search-card__subtitle").text()),
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      locations: location ? [location] : [],
      geographicRestrictions: location ? [location] : [],
      workplaceModel: workplace(location),
      detailStatus: "fallback",
      timestampSemantics: publishedAt ? "source-publication-date" : "unknown",
      qualityEvidence: {
        provider: "linkedin",
        access: "public-guest",
        dateGranularity: "day",
      },
    };
    if (publishedAt) job.publishedAt = publishedAt;
    jobs.push(job);
  });
  return { jobs, errors, empty: false };
}
export function linkedinGuestDetail(html: string, id: string): Partial<Job> {
  const $ = cheerio.load(html);
  const canonical = $('link[rel="canonical"]').attr("href");
  if (!canonical || siteJobId("linkedin", canonical) !== id)
    throw Error("LinkedIn guest detail identity mismatch");
  const description = clean($(".show-more-less-html__markup").first().html());
  if (!description) throw Error("Missing LinkedIn guest detail description");
  return {
    description,
    detailStatus: "full",
    qualityEvidence: {
      provider: "linkedin",
      access: "public-guest",
      detailIdentity: id,
    },
  };
}
export function jobPostings(html: string): any[] {
  const $ = cheerio.load(html),
    result: any[] = [];
  const visit = (obj: any) => {
    if (Array.isArray(obj)) {
      obj.forEach(visit);
      return;
    }
    if (!obj || typeof obj !== "object") return;
    if (
      obj["@type"] === "JobPosting" ||
      (Array.isArray(obj["@type"]) && obj["@type"].includes("JobPosting"))
    )
      result.push(obj);
    if (obj["@graph"]) visit(obj["@graph"]);
    if (obj.itemListElement)
      for (const item of obj.itemListElement) visit(item.item ?? item);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {
      /* Other page metadata may be malformed. */
    }
  });
  return result;
}
export function structuredJob(r: any, fallbackUrl: string, id: string): Job {
  const url = https(r.url) ?? https(fallbackUrl);
  if (!url || !id || !clean(r.title))
    throw Error("Invalid JobPosting identity/title/URL");
  const arr = (value: any) =>
    value ? (Array.isArray(value) ? value : [value]) : [];
  const locations = arr(r.jobLocation)
    .map((l: any) => {
      const a = l?.address;
      return typeof a === "string"
        ? a
        : [
            a?.addressLocality,
            a?.addressRegion,
            typeof a?.addressCountry === "string"
              ? a.addressCountry
              : a?.addressCountry?.name,
          ]
            .map(string)
            .filter(Boolean)
            .join(", ");
    })
    .filter(Boolean);
  const restrictions = arr(r.applicantLocationRequirements)
    .map((l: any) => string(l?.name || l?.address?.addressCountry))
    .filter(Boolean);
  const description = clean(r.description),
    publishedAt = date(r.datePosted);
  const job: Job = {
    externalId: id,
    title: clean(r.title),
    url,
    employer: clean(r.hiringOrganization?.name),
    description,
    locations,
    geographicRestrictions: restrictions.length ? restrictions : locations,
    workplaceModel: workplace(
      locations.join(" "),
      /TELECOMMUTE/i.test(string(r.jobLocationType))
        ? "remote"
        : string(r.jobLocationType),
    ),
    employmentType: arr(r.employmentType).map(string).join(", "),
    detailStatus: description ? "full" : "fallback",
    timestampSemantics: publishedAt ? "source-publication" : "unknown",
    qualityEvidence: {
      format: "JobPosting",
      validThrough: r.validThrough ?? null,
    },
  };
  if (publishedAt) job.publishedAt = publishedAt;
  salary(
    job,
    typeof r.baseSalary?.value === "number"
      ? { value: r.baseSalary.value }
      : r.baseSalary?.value,
    r.baseSalary?.currency,
  );
  return job;
}
export function indeedDetail(html: string, expectedId: string): Partial<Job> {
  try {
    const data = embeddedJson(html, /window\._initialData\s*=\s*/);
    const results =
      data.hostQueryExecutionResult?.data?.jobData?.results ??
      data.autoOpenTwoPaneViewjobResponse?.body?.hostQueryExecutionResult?.data
        ?.jobData?.results;
    const r = results?.[0]?.job;
    if (r) {
      const key = string(r.jobkey || r.jobKey || r.key);
      if (key && key !== expectedId)
        throw Error("Indeed detail identity mismatch");
      const description = clean(r.description?.text || r.description?.html);
      if (description)
        return {
          description,
          detailStatus: "full",
          qualityEvidence: {
            provider: "indeed",
            detailIdentity: key || "request-url",
          },
        };
    }
  } catch (e) {
    if (String(e).includes("identity mismatch")) throw e;
  }
  const r = jobPostings(html)[0];
  if (!r) throw Error("Missing Indeed detail description");
  const url = string(r.url);
  if (
    url &&
    new URL(url).searchParams.get("jk") &&
    new URL(url).searchParams.get("jk") !== expectedId
  )
    throw Error("Indeed detail identity mismatch");
  const job = structuredJob(
    r,
    `https://eg.indeed.com/viewjob?jk=${expectedId}`,
    expectedId,
  );
  if (!job.description) throw Error("Missing Indeed detail description");
  // A detail URL is not necessarily the application URL; retain the listing identity.
  return {
    description: job.description,
    detailStatus: "full",
    ...(job.budgetMin !== undefined ? { budgetMin: job.budgetMin } : {}),
    ...(job.budgetMax !== undefined ? { budgetMax: job.budgetMax } : {}),
    ...(job.compensationCurrency
      ? { compensationCurrency: job.compensationCurrency }
      : {}),
    ...(job.publishedAt
      ? {
          publishedAt: job.publishedAt,
          timestampSemantics: job.timestampSemantics,
        }
      : {}),
  };
}
export function parseWuzzuf(html: string): ParsedPage {
  const entities = embeddedJson(html, /"job"\s*:\s*\{\s*"collection"\s*:/);
  if (!entities || typeof entities !== "object" || Array.isArray(entities))
    throw Error("Malformed WUZZUF inventory");
  const $ = cheerio.load(html),
    jobs: Job[] = [],
    errors: string[] = [];
  for (const r of Object.values(entities) as any[]) {
    const a = r?.attributes;
    const slug = string(a?.slug),
      id = slug.split("/").at(-1)?.split("-")[0] ?? "";
    if (!a || !id || !/^[\w]+$/.test(id) || !clean(a.title)) {
      errors.push("Invalid WUZZUF identity/title");
      continue;
    }
    const anchor = $(`a[href*="/jobs/p/${id}-"]`).first();
    const card = anchor.closest("div").parent();
    const location =
      [
        a.location?.area?.name,
        a.location?.city?.name || a.city?.name,
        a.location?.country?.name || a.country?.name,
      ]
        .map(string)
        .filter(Boolean)
        .join(", ") || clean(card.find("span.css-16x61xq").text());
    const company = (
      clean(a.company?.name) || clean(card.find("a.css-ipsyv7").text())
    ).replace(/\s*-\s*$/, "");
    const description = [clean(a.description), clean(a.requirements)]
      .filter(Boolean)
      .join("\n\n");
    const job: Job = {
      externalId: id,
      title: clean(a.title),
      url: `https://wuzzuf.net/jobs/p/${slug.split("/").at(-1)}`,
      employer: company,
      description,
      locations: location ? [location] : [],
      geographicRestrictions: location ? [location] : [],
      workplaceModel: workplace(
        location,
        string(a.workplaceArrangement?.displayedName),
      ),
      employmentType: Array.isArray(a.workTypes)
        ? a.workTypes
            .map((x: any) => string(x?.displayedName))
            .filter(Boolean)
            .join(", ")
        : "",
      seniority: string(a.careerLevel?.name),
      skills: Array.isArray(a.keywords)
        ? a.keywords.map((x: any) => string(x?.name)).filter(Boolean)
        : [],
      status: string(a.status),
      detailStatus: description ? "full" : "fallback",
      timestampSemantics: "unknown",
      qualityEvidence: {
        provider: "wuzzuf",
        rawPublishedAt: a.postedAt ?? null,
        timestampTimezone: "unspecified source local time",
        requirements: clean(a.requirements),
      },
    };
    // WUZZUF emits local timestamps without an offset. Do not manufacture UTC publication times.
    if (string(a.postedAt) && /(?:Z|[+-]\d\d:\d\d)$/.test(a.postedAt)) {
      const d = date(a.postedAt);
      if (d) {
        job.publishedAt = d;
        job.timestampSemantics = "source-publication";
      }
    }
    salary(job, a.salary);
    if (string(a.salary?.additionalDetails))
      job.budgetText = string(a.salary.additionalDetails);
    jobs.push(job);
  }
  return { jobs, errors, empty: Object.keys(entities).length === 0 };
}
export function relativeDate(value: string, now: Date): string | undefined {
  const m = value.match(/\b(\d+)\s+(minute|hour|day|week|month)s?\b/i);
  if (!m) return undefined;
  const units: Record<string, number> = {
    minute: 60_000,
    hour: 3600_000,
    day: 86400_000,
    week: 604800_000,
    month: 2592000_000,
  };
  return date(now.getTime() - Number(m[1]) * units[m[2]!.toLowerCase()]!);
}
export function linkedinDetail(
  html: string,
  expectedId: string,
  selectors: Record<string, string>,
  now = new Date(),
): Job {
  const $ = cheerio.load(html);
  // Match an explicit detail header link; list links can still point at the previous job.
  const link = $(selectors.identity!).first().attr("href") ?? "";
  const id = link.match(/\/jobs\/view\/(?:[^/?]*-)?(\d+)(?:[/?]|$)/)?.[1];
  if (id !== expectedId)
    throw Error("LinkedIn detail identity mismatch or missing identity");
  const title = clean($(selectors.title!).first().text()),
    description = clean($(selectors.description!).first().html());
  if (!title || !description) throw Error("LinkedIn detail not hydrated");
  const location = clean($(selectors.location!).first().text());
  const rawDate = clean($(selectors.posted!).first().text()),
    publishedAt = relativeDate(rawDate, now);
  const job: Job = {
    externalId: expectedId,
    title,
    url: `https://www.linkedin.com/jobs/view/${expectedId}/`,
    employer: clean($(selectors.company!).first().text()),
    description,
    locations: location ? [location] : [],
    geographicRestrictions: location ? [location] : [],
    workplaceModel: workplace(location),
    detailStatus: "full",
    timestampSemantics: publishedAt
      ? "estimated-relative-publication"
      : "unknown",
    qualityEvidence: {
      provider: "linkedin",
      rawPublishedAt: rawDate,
      observedAt: now.toISOString(),
    },
  };
  if (publishedAt) job.publishedAt = publishedAt;
  return job;
}
export function siteJobId(site: Website, url: string): string | undefined {
  const u = new URL(url);
  if (site === "indeed") return u.searchParams.get("jk") ?? undefined;
  if (site === "linkedin")
    return u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1];
  if (site === "wuzzuf") return u.pathname.match(/\/jobs\/p\/([\w]+)-/)?.[1];
  if (site === "forasna") {
    const slug = u.pathname.match(/\/job\/p\/([^/]+)\/?$/)?.[1];
    if (!slug) return undefined;
    return slug.match(/^(\d+)(?:-|$)/)?.[1] ?? slug.match(/-(\d+)$/)?.[1];
  }
  if (site === "bayt") return u.pathname.match(/-(\d+)\/?$/)?.[1];
  return u.pathname.match(/\/jobs\/(\d+)(?:-|\/|$)/)?.[1];
}
export function parseStructuredPage(
  site: Website,
  html: string,
  url: string,
): ParsedPage {
  const rows = jobPostings(html),
    jobs: Job[] = [],
    errors: string[] = [];
  for (const r of rows) {
    try {
      const listing = https(r.url) ?? url;
      const id =
        siteJobId(site, listing) ??
        (typeof r.identifier?.value === "string" ||
        typeof r.identifier?.value === "number"
          ? String(r.identifier.value)
          : undefined);
      const job = structuredJob(r, listing, id ?? "");
      if (
        site === "forasna" &&
        !job.description &&
        id === siteJobId(site, url)
      ) {
        const $ = cheerio.load(html);
        const description = clean($(".job-more-info .job-bio").html());
        const requirements = $(".job-requirements-cols li")
          .toArray()
          .map((el) => {
            const label = clean($(el).find(".title-lable").text()),
              value = clean($(el).find(".item-info").text());
            return value ? `${label}: ${value}` : "";
          })
          .filter(Boolean)
          .join("\n");
        job.description = [description, requirements]
          .filter(Boolean)
          .join("\n\n");
        job.detailStatus = job.description ? "full" : "fallback";
        job.qualityEvidence = {
          ...(job.qualityEvidence as object),
          descriptionSource: description
            ? "job-bio"
            : "structured requirements",
        };
      }
      jobs.push(job);
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { jobs, errors, empty: false };
}
