import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Inventory, Job, Target } from "../types.js";
import type { SiteSession } from "./browser.js";
import { allowedUrl, positiveInt } from "./browser.js";
import {
  blockedPage,
  parseIndeed,
  indeedDetail,
  parseWuzzuf,
  linkedinDetail,
  parseLinkedInGuest,
  linkedinGuestDetail,
  parseStructuredPage,
  siteJobId,
  type Website,
} from "./parsers.js";
export const websites: Website[] = [
  "indeed",
  "linkedin",
  "wuzzuf",
  "forasna",
  "bayt",
  "wellfound",
];
export function isWebsite(provider: string): provider is Website {
  return websites.includes(provider as Website);
}
export async function collectWebsite(
  t: Target,
  session: SiteSession,
  knownFullIds: ReadonlySet<string> = new Set(),
): Promise<Inventory> {
  if (!isWebsite(t.provider) || !allowedUrl(t.provider, t.url))
    throw Error("Invalid website target");
  const site = t.provider;
  const inv: Inventory = {
    jobs: [],
    scope: "rolling-feed",
    complete: false,
    errors: [],
  };
  const selectors = JSON.parse(
    await readFile(
      new URL("../../../data/selectors/websites.json", import.meta.url),
      "utf8",
    ),
  )[site] as Record<string, string> | undefined;
  const linked = JSON.parse(
    await readFile(
      new URL("../../../data/selectors/linkedin.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, string>;
  const maxPages = positiveInt(
    `${site.toUpperCase()}_MAX_PAGES`,
    site === "indeed"
      ? 1
      : site === "wuzzuf"
        ? 20
        : site === "linkedin"
          ? 4
          : 5,
    100,
  );
  const detailCap = positiveInt(
    `${site.toUpperCase()}_MAX_DETAILS`,
    site === "indeed" ? 10 : 100,
    1000,
  );
  if (site === "indeed" && maxPages !== 1)
    throw Error(
      "Indeed supports first-page collection only; INDEED_MAX_PAGES must be 1",
    );
  const fingerprints = new Set<string>(),
    urls = new Set<string>();
  let url = t.url,
    details = 0;
  const merge = (job: Job) => {
    const index = inv.jobs.findIndex((j) => j.externalId === job.externalId);
    if (index < 0) inv.jobs.push(job);
    else inv.jobs[index] = job;
  };
  try {
    for (let page = 0; page < maxPages; page++) {
      if (urls.has(url)) throw Error("Repeated website pagination URL");
      urls.add(url);
      if (site === "linkedin") {
        const listing = await session.read(url);
        if (blockedPage(listing, url)) throw Error("LinkedIn login/challenge");
        if (cheerio.load(listing)(".base-card[data-entity-urn]").length) {
          const parsed = parseLinkedInGuest(listing);
          inv.errors.push(...parsed.errors);
          for (const job of parsed.jobs.sort(
            (a, b) =>
              Number(knownFullIds.has(a.externalId)) -
              Number(knownFullIds.has(b.externalId)),
          )) {
            try {
              if (details >= detailCap)
                throw Error("Detail cap reached; retry next run");
              details++;
              const html = await session.read(job.url);
              if (blockedPage(html, job.url))
                throw Error("LinkedIn guest detail blocked");
              Object.assign(job, linkedinGuestDetail(html, job.externalId));
            } catch (e) {
              inv.errors.push(`Detail ${job.externalId}: ${e}`);
            }
            merge(job);
          }
          // Guest search is explicitly a bounded first-page feed, not an exhaustive board.
          inv.complete = parsed.errors.length === 0;
          return inv;
        }
        if (!session.linkedinDetails)
          throw Error("LinkedIn requires an interactive browser collector");
        const remaining = Math.max(0, detailCap - details);
        const cards = await session.linkedinDetails(
          url,
          linked,
          remaining,
          knownFullIds,
        );
        details += Math.min(remaining, cards.length);
        if (!cards.length) {
          const html = await session.read(url);
          if (blockedPage(html, url)) throw Error("LinkedIn login/challenge");
          if (!cheerio.load(html)(linked.empty!).length)
            throw Error("Unverified empty LinkedIn inventory");
          inv.complete = inv.errors.length === 0;
          return inv;
        }
        const fingerprint = cards
          .map((c) => c.id)
          .sort()
          .join(",");
        if (fingerprints.has(fingerprint))
          throw Error("Repeated LinkedIn page");
        fingerprints.add(fingerprint);
        for (const c of cards) {
          try {
            merge(linkedinDetail(c.html, c.id, linked));
          } catch (e) {
            inv.errors.push(`Detail ${c.id}: ${e}`);
            if (c.title)
              merge({
                externalId: c.id,
                title: c.title,
                employer: c.company,
                url: `https://www.linkedin.com/jobs/view/${c.id}/`,
                locations: c.location ? [c.location] : [],
                geographicRestrictions: c.location ? [c.location] : [],
                workplaceModel: /remote/i.test(c.location)
                  ? "remote"
                  : "unknown",
                detailStatus: "fallback",
                timestampSemantics: "unknown",
                qualityEvidence: { provider: site, detailFailed: true },
              });
          }
        }
        if (cards.length < 25) {
          inv.complete = inv.errors.length === 0;
          return inv;
        }
        const next = new URL(t.url);
        next.searchParams.set(
          "start",
          String(
            Number(new URL(t.url).searchParams.get("start") ?? 0) +
              (page + 1) * 25,
          ),
        );
        url = next.href;
      } else {
        const html = await session.read(url);
        if (blockedPage(html, url)) throw Error("Website login/challenge");
        const $ = cheerio.load(html);
        if (site === "indeed") {
          const parsed = parseIndeed(html, new URL(t.url).origin);
          inv.errors.push(...parsed.errors);
          for (const job of parsed.jobs.sort(
            (a, b) =>
              Number(knownFullIds.has(a.externalId)) -
              Number(knownFullIds.has(b.externalId)),
          )) {
            if (details < detailCap) {
              details++;
              try {
                const detail = await session.read(job.url);
                if (blockedPage(detail, job.url)) throw Error("Blocked detail");
                Object.assign(job, indeedDetail(detail, job.externalId));
              } catch (e) {
                inv.errors.push(`Detail ${job.externalId}: ${e}`);
              }
            } else
              inv.errors.push(
                `Detail ${job.externalId}: detail cap reached; retry next run`,
              );
            merge(job);
          }
          // Complete describes this declared first-page search scope, not all Indeed jobs.
          inv.complete = parsed.errors.length === 0;
          return inv;
        }
        if (site === "wuzzuf") {
          const parsed = parseWuzzuf(html);
          inv.errors.push(...parsed.errors);
          const fingerprint = parsed.jobs
            .map((j) => j.externalId)
            .sort()
            .join(",");
          if (fingerprints.has(fingerprint))
            throw Error("Repeated WUZZUF inventory");
          fingerprints.add(fingerprint);
          parsed.jobs.forEach(merge);
          if (parsed.empty || parsed.jobs.length < 15) {
            inv.complete = inv.errors.length === 0;
            return inv;
          }
          const next = new URL(t.url);
          next.searchParams.set(
            "start",
            String(
              Number(new URL(t.url).searchParams.get("start") ?? 0) + page + 1,
            ),
          );
          url = next.href;
        } else {
          const parsed = parseStructuredPage(site, html, url);
          inv.errors.push(...parsed.errors);
          for (const job of parsed.jobs) {
            if (!allowedUrl(site, job.url)) {
              inv.errors.push("JobPosting URL outside provider");
              continue;
            }
            merge(job);
          }
          const links = Array.from(
            new Set(
              $(selectors!.links!)
                .toArray()
                .flatMap((el) => {
                  try {
                    const href = new URL($(el).attr("href") ?? "", url).href;
                    return allowedUrl(site, href) && siteJobId(site, href)
                      ? [href]
                      : [];
                  } catch {
                    return [];
                  }
                }),
            ),
          );
          const pageIds = [
            ...new Set([
              ...parsed.jobs.map((j) => j.externalId),
              ...links.map((link) => siteJobId(site, link)!),
            ]),
          ]
            .sort()
            .join(",");
          if (pageIds && fingerprints.has(pageIds))
            throw Error("Repeated structured website inventory");
          if (pageIds) fingerprints.add(pageIds);
          for (const link of links) {
            if (
              inv.jobs.some(
                (j) =>
                  j.externalId === siteJobId(site, link) &&
                  j.detailStatus === "full",
              )
            )
              continue;
            const title =
              $(`a`)
                .filter((_, el) => {
                  try {
                    return new URL($(el).attr("href") ?? "", url).href === link;
                  } catch {
                    return false;
                  }
                })
                .toArray()
                .map((el) => $(el).text().trim())
                .find(Boolean) ?? "";
            let found = false;
            try {
              if (details >= detailCap) throw Error("Detail cap reached");
              details++;
              const detail = await session.read(link);
              if (blockedPage(detail, link)) throw Error("Blocked detail");
              const p = parseStructuredPage(site, detail, link);
              inv.errors.push(...p.errors);
              const job = p.jobs.find(
                (j) =>
                  j.externalId === siteJobId(site, link) &&
                  allowedUrl(site, j.url),
              );
              if (!job) throw Error("Missing matching JobPosting detail");
              merge(job);
              found = true;
              if (!job.description)
                inv.errors.push(
                  `Detail ${job.externalId}: description unavailable`,
                );
            } catch (e) {
              inv.errors.push(`Detail ${siteJobId(site, link)}: ${e}`);
            }
            if (!found && title)
              merge({
                externalId: siteJobId(site, link)!,
                title,
                url: link,
                detailStatus: "fallback",
                timestampSemantics: "unknown",
                qualityEvidence: { provider: site, detailFailed: true },
              });
          }
          if (!parsed.jobs.length && !links.length)
            throw Error("No verified inventory or explicit empty evidence");
          const next = $(selectors!.next!).first().attr("href");
          if (!next) {
            inv.complete = inv.errors.length === 0;
            return inv;
          }
          url = new URL(next, url).href;
          if (!allowedUrl(site, url))
            throw Error("Pagination outside provider");
        }
      }
    }
    throw Error("Website pagination capped");
  } catch (e) {
    inv.errors.push(String(e));
    return inv;
  }
}
