import * as cheerio from "cheerio";
import { parseMostaqlListing, parseMostaqlProjectDetail } from "../mostaql.js";
import {
  parseKhamsatListing,
  parseKhamsatDetail,
  buildKhamsatPageUrl,
} from "../khamsat.js";
import { SOURCES } from "../index.js";
import type { Inventory, Job, Target } from "./types.js";
import type { Request } from "./adapters.js";
import { sanitizeHtml, date } from "./adapters.js";
export async function collectMarketplace(
  t: Target,
  request: Request,
): Promise<Inventory> {
  const inv: Inventory = {
    jobs: [],
    scope: "bounded-marketplace",
    complete: false,
    errors: [],
  };
  try {
    if (t.provider === "ureed") {
      const seen = new Set<string>();
      for (let page = 1; page <= 100; page++) {
        const body = await request(
          SOURCES.find((s) => s.name === "ureed")!.url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query:
                "query allProjects($filters: AllProjectsFiltersInput) { allProjects(filters: $filters) { projects { id name budget budgetType description publishedOn category { name nameAr } skills { name } } } }",
              variables: {
                filters: { categories: [], page, size: 50, text: "" },
              },
            }),
          },
        );
        const payload = JSON.parse(body);
        if (payload.errors?.length) throw Error("Ureed GraphQL errors");
        const rows = payload.data?.allProjects?.projects;
        if (!Array.isArray(rows)) throw Error("Malformed Ureed inventory");
        for (const r of rows) {
          if (!r.id || !r.name) throw Error("Invalid Ureed job");
          if (seen.has(String(r.id))) throw Error("Repeated Ureed page");
          seen.add(String(r.id));
          const published = date(r.publishedOn);
          inv.jobs.push({
            externalId: String(r.id),
            title: r.name,
            url: `https://app.ureed.com/project/${r.id}`,
            description: sanitizeHtml(r.description ?? ""),
            category: r.category?.name || r.category?.nameAr || "",
            skills: (r.skills ?? []).map((s: any) => s.name).filter(Boolean),
            ...(published ? { publishedAt: published } : {}),
            ...(Number.isFinite(Number(r.budget)) && r.budget !== null
              ? { budgetMin: Number(r.budget), budgetText: String(r.budget) }
              : {}),
            timestampSemantics: "source-publication",
            qualityEvidence: { budgetType: r.budgetType, raw: r },
          });
        }
        if (rows.length < 50) {
          inv.complete = true;
          return inv;
        }
      }
      throw Error("Ureed pagination capped");
    }
    const config = SOURCES.find((s) => s.name === t.provider)!;
    let url = config.url;
    const max = Number(
      process.env[`${t.provider.toUpperCase()}_MAX_PAGES`] ?? 5,
    );
    const seen = new Set<string>();
    for (let page = 1; page <= max; page++) {
      const html = await request(url);
      const $ = cheerio.load(html);
      if (
        /captcha|just a moment|access denied|verify you are human/i.test(
          $("title").text(),
        )
      )
        throw Error("Blocked listing");
      const rows =
        t.provider === "mostaql"
          ? parseMostaqlListing(html, config.baseUrl)
          : t.provider === "khamsat"
            ? parseKhamsatListing(html, config.baseUrl)
            : $(".project-box")
                .toArray()
                .flatMap((el) => {
                  const a = $(el).find("a.text-truncate").first();
                  const href = a.attr("href");
                  const id = href?.match(/\/project\/(\d+)/)?.[1];
                  return href && id
                    ? [
                        {
                          sourceProjectId: id,
                          title: a.text().trim(),
                          url: new URL(href, config.baseUrl).href,
                          rawText: $(el).text().trim(),
                        },
                      ]
                    : [];
                });
      if (!rows.length)
        throw Error(
          "Empty HTML inventory lacks explicit structured empty evidence",
        );
      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.sourceProjectId)) continue;
        seen.add(row.sourceProjectId);
        fresh++;
        const j: Job = {
          externalId: row.sourceProjectId,
          title: row.title,
          url: row.url,
          timestampSemantics: "unknown",
          qualityEvidence: { listingUrl: url },
          detailStatus: "fallback",
        };
        try {
          const detail = await request(row.url);
          if (t.provider === "nafezly") {
            const d = cheerio.load(detail);
            j.description = d("h2.naskh").text().trim();
            if (!j.description) throw Error("Missing detail description");
            j.skills = d('a[href*="/projects/skill/"]')
              .toArray()
              .map((e) => d(e).text().trim());
            const published = date(
              d("time[datetime]").first().attr("datetime"),
            );
            if (published) j.publishedAt = published;
          } else {
            const d =
              t.provider === "mostaql"
                ? parseMostaqlProjectDetail(detail)
                : parseKhamsatDetail(detail, config.baseUrl, row.url);
            if (!d.description) throw Error("Missing detail description");
            j.description = d.description;
            j.title = d.title || row.title;
            if (d.category) j.category = d.category;
            if (d.publishedAt) j.publishedAt = d.publishedAt.toISOString();
            if ("budgetMin" in d && d.budgetMin !== undefined)
              j.budgetMin = d.budgetMin;
            if ("budgetMax" in d && d.budgetMax !== undefined)
              j.budgetMax = d.budgetMax;
            if ("budgetText" in d && d.budgetText) j.budgetText = d.budgetText;
            if ("skills" in d && d.skills) j.skills = d.skills;
            if ("status" in d && d.status) j.status = d.status;
          }
          j.detailStatus = "full";
          j.timestampSemantics = j.publishedAt
            ? "source-publication"
            : "unknown";
        } catch (e) {
          inv.errors.push(`Detail ${row.sourceProjectId}: ${e}`);
          j.qualityEvidence = { detailFailed: true };
          j.description = sanitizeHtml(row.rawText);
        }
        inv.jobs.push(j);
      }
      if (!fresh) throw Error("Repeated pagination inventory");
      const next =
        t.provider === "khamsat"
          ? buildKhamsatPageUrl(html, config.baseUrl, page + 1)
          : $(
              'a[rel="next"], a[aria-label="Next »"], a[data-page-number="' +
                (page + 1) +
                '"]',
            )
              .first()
              .attr("href");
      if (!next) {
        inv.complete = inv.errors.length === 0;
        return inv;
      }
      url = new URL(next, config.baseUrl).href;
    }
    throw Error("Pagination capped");
  } catch (e) {
    inv.errors.push(String(e));
    return inv;
  }
}
