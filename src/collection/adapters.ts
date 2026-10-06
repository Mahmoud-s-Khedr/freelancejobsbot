// ATS mappings adapted from OpenIntern (Apache-2.0); see docs/THIRD_PARTY_NOTICES.md.
import * as cheerio from "cheerio";
import type { Target, Job, Inventory } from "./types.js";
const text = (x: unknown): string => (typeof x === "string" ? x : "");
export function date(x: unknown): string | undefined {
  if (x === null || x === undefined || x === "") return undefined;
  const d = new Date(x as string | number);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}
export function sanitizeHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script,style,noscript,iframe,svg,template,link,meta").remove();
  return $.root().text().replace(/\s+/g, " ").trim();
}
export function parsePayload(t: Target, payload: unknown): Inventory {
  const p = payload as any;
  const scope = ["greenhouse", "ashby", "lever"].includes(t.provider)
    ? "full-board"
    : "rolling-feed";
  let rows: any[];
  if (t.provider === "wwr") {
    const $ = cheerio.load(text(p), { xml: true });
    if (!$("rss channel").length) throw Error("Malformed RSS inventory");
    rows = $("item")
      .toArray()
      .map((el) => {
        const item = $(el);
        return {
          id: item.find("guid").text() || item.find("link").text(),
          title: item.find("title").text(),
          url: item.find("link").text(),
          description: item.find("description").text(),
          date: item.find("pubDate").text(),
          location: item.find("region").text(),
          company:
            item.find("company").text() ||
            item.find("title").text().split(":")[0],
        };
      });
  } else if (t.provider === "lever" || t.provider === "remoteok") {
    if (!Array.isArray(p)) throw Error("Expected array");
    rows = t.provider === "remoteok" ? p.filter((r: any) => !r?.legal) : p;
  } else {
    if (!p || !Array.isArray(p.jobs)) throw Error("Expected jobs array");
    rows = p.jobs;
  }
  const jobs: Job[] = [];
  const errors: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      errors.push("Invalid job object");
      continue;
    }
    const title = text(r.title || r.text || r.position);
    const url = text(
      r.absolute_url || r.jobUrl || r.hostedUrl || r.url || r.applicationLink,
    );
    const id = r.id ?? r.guid ?? r.slug ?? r.applicationLink;
    if (
      !["string", "number"].includes(typeof id) ||
      id === undefined ||
      id === null ||
      !String(id) ||
      !title ||
      !/^https:\/\//.test(url)
    ) {
      errors.push("Invalid job identity/title/URL");
      continue;
    }
    const locations = Array.isArray(r.locationRestrictions)
      ? r.locationRestrictions.map((x: any) =>
          typeof x === "string" ? x : text(x?.name) || text(x?.alpha2),
        )
      : [
          text(
            r.location?.name ||
              r.categories?.location ||
              r.location ||
              r.candidate_required_location,
          ),
        ].filter(Boolean);
    if (t.provider === "ashby") {
      for (const secondary of Array.isArray(r.secondaryLocations)
        ? r.secondaryLocations
        : [])
        if (typeof secondary?.location === "string")
          locations.push(secondary.location);
    }
    const remote =
      r.isRemote === true ||
      ["himalayas", "remotive", "remoteok", "wwr"].includes(t.provider) ||
      /remote/i.test(locations.join(" ")) ||
      text(r.workplaceType).toLowerCase() === "remote";
    const publication =
      t.provider === "greenhouse"
        ? undefined
        : date(
            r.publishedAt ??
              r.createdAt ??
              r.publication_date ??
              r.pubDate ??
              r.date,
          );
    const updated =
      t.provider === "greenhouse" ? date(r.updated_at) : date(r.updatedAt);
    const job: Job = {
      externalId: String(id),
      title,
      url,
      description: sanitizeHtml(
        text(
          r.descriptionPlain ||
            r.descriptionPlainText ||
            r.content ||
            r.descriptionHtml ||
            r.description,
        ),
      ),
      employer: text(
        r.company_name || r.companyName || r.company || t.employer,
      ),
      locations,
      workplaceModel: remote ? "remote" : text(r.workplaceType) || "unknown",
      geographicRestrictions: locations,
      category: text(
        r.category ||
          r.department ||
          (Array.isArray(r.categories)
            ? r.categories.join(", ")
            : r.categories?.team),
      ),
      employmentType: text(
        r.employmentType || r.job_type || r.categories?.commitment,
      ),
      seniority: Array.isArray(r.seniority)
        ? r.seniority.join(", ")
        : text(r.seniority),
      timestampSemantics:
        t.provider === "greenhouse"
          ? "update-only"
          : t.provider === "ashby"
            ? "source-publication-or-republication"
            : "source-publication",
      qualityEvidence: { provider: t.provider, raw: r },
    };
    if (typeof r.applyUrl === "string" && r.applyUrl.startsWith("https://"))
      job.applicationUrl = r.applyUrl;
    if (Array.isArray(r.timezoneRestrictions) && r.timezoneRestrictions.length)
      job.geographicRestrictions = [
        ...locations,
        ...r.timezoneRestrictions.map((x: unknown) => "Timezone: " + String(x)),
      ];
    if (publication) job.publishedAt = publication;
    if (updated) job.sourceUpdatedAt = updated;
    const salary = r.salaryRange || r.compensation?.salaryRange;
    if (salary && typeof salary === "object") {
      if (Number.isFinite(salary.min)) job.budgetMin = salary.min;
      if (Number.isFinite(salary.max)) job.budgetMax = salary.max;
      job.compensationCurrency = text(salary.currency);
      job.compensationPeriod = text(salary.interval);
    }
    if (t.provider === "ashby") {
      const salaryComponents = (
        Array.isArray(r.compensation?.summaryComponents)
          ? r.compensation.summaryComponents
          : []
      ).filter((c: any) => c.compensationType === "Salary");
      if (salaryComponents.length === 1) {
        const c = salaryComponents[0];
        if (Number.isFinite(c.minValue)) job.budgetMin = c.minValue;
        if (Number.isFinite(c.maxValue)) job.budgetMax = c.maxValue;
        job.compensationCurrency = text(c.currencyCode);
        job.compensationPeriod = text(c.interval);
      }
      if (
        typeof r.compensation?.scrapeableCompensationSalarySummary === "string"
      )
        job.budgetText = r.compensation.scrapeableCompensationSalarySummary;
    }
    if (t.provider === "himalayas") {
      if (Number.isFinite(r.minSalary)) job.budgetMin = r.minSalary;
      if (Number.isFinite(r.maxSalary)) job.budgetMax = r.maxSalary;
      job.compensationCurrency = text(r.currency);
      job.compensationPeriod = text(r.salaryPeriod) || "annual";
    }
    if (typeof r.salary === "string") job.budgetText = r.salary;
    jobs.push(job);
  }
  return { jobs, scope, complete: errors.length === 0, errors };
}
export type Request = (url: string, init?: RequestInit) => Promise<string>;
export async function collect(
  t: Target,
  request: Request,
  sink?: (batch: Inventory) => Promise<void>,
): Promise<Inventory> {
  const result: Inventory = {
    jobs: [],
    scope: t.provider === "himalayas" ? "full-board" : "rolling-feed",
    complete: false,
    errors: [],
  };
  let url = t.url;
  const cursors = new Set<string>();
  try {
    const maxPages = Number(process.env.HIMALAYAS_MAX_PAGES ?? 10000);
    for (let page = 0; page < maxPages; page++) {
      const body = await request(url);
      const payload = t.provider === "wwr" ? body : JSON.parse(body);
      const inv = parsePayload(t, payload);
      result.jobs.push(...inv.jobs);
      result.observedCount = (result.observedCount ?? 0) + inv.jobs.length;
      if (t.provider === "himalayas" && (page === 0 || (page + 1) % 50 === 0)) {
        console.error(
          JSON.stringify({
            event: "collection_progress",
            source: t.id,
            pages: page + 1,
            jobs: result.observedCount,
            totalCount: payload.totalCount ?? null,
          }),
        );
      }
      result.errors.push(...inv.errors);
      result.scope = t.provider === "himalayas" ? "full-board" : inv.scope;
      if (sink && t.provider === "himalayas" && result.jobs.length >= 200) {
        await sink({
          jobs: result.jobs,
          scope: result.scope,
          complete: false,
          errors: [],
        });
        result.jobs = [];
      }
      if (t.provider !== "himalayas") {
        result.complete = inv.complete;
        return result;
      }
      const cursor = payload.nextCursor ?? payload.pagination?.nextCursor;
      if (!cursor) {
        if (payload.hasMore === true || payload.pagination?.hasMore === true)
          throw Error("Missing next cursor");
        result.complete = result.errors.length === 0;
        return result;
      }
      if (typeof cursor !== "string" || cursors.has(cursor))
        throw Error("Invalid/repeated cursor");
      cursors.add(cursor);
      const next = new URL(t.url);
      next.searchParams.set("cursor", cursor);
      url = next.href;
    }
    throw Error("Pagination capped");
  } catch (e) {
    result.errors.push(String(e));
    return result;
  }
}
