import { chromium, type BrowserContext, type Page } from "playwright";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { logEvent, redact } from "../../logging.js";
import { paceHost, applyCooldown } from "../request.js";
import { blockedPage, type Website } from "./parsers.js";
export interface SiteSession {
  read(url: string): Promise<string>;
  linkedinDetails?(
    url: string,
    selectors: Record<string, string>,
    maxDetails?: number,
    knownFullIds?: ReadonlySet<string>,
  ): Promise<
    {
      html: string;
      id: string;
      title: string;
      company: string;
      location: string;
    }[]
  >;
}
export function positiveInt(
  name: string,
  fallback: number,
  cap = 1000,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > cap)
    throw Error(`${name} must be an integer between 1 and ${cap}`);
  return value;
}
const domains: Record<Website, string> = {
  indeed: "indeed.com",
  linkedin: "linkedin.com",
  wuzzuf: "wuzzuf.net",
  forasna: "forasna.com",
  bayt: "bayt.com",
  wellfound: "wellfound.com",
};
export function allowedUrl(site: Website, url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (u.hostname === domains[site] || u.hostname.endsWith(`.${domains[site]}`))
    );
  } catch {
    return false;
  }
}
// Browser profiles hold authentication state and are never tracked or exported.
export async function profileLock(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, ".collector.lock"),
    owner = randomUUID();
  try {
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, host: hostname(), owner }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    let previous: any;
    try {
      previous = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw Error("Browser profile lock unreadable; inspect before removing");
    }
    if (previous.host !== hostname())
      throw Error("Browser profile is locked on another host");
    try {
      process.kill(previous.pid, 0);
      throw Error("Browser profile already in use");
    } catch (e: any) {
      if (e.code !== "ESRCH") throw e;
    }
    await unlink(file);
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, host: hostname(), owner }),
      { flag: "wx", mode: 0o600 },
    );
  }
  return async () => {
    try {
      if (JSON.parse(await readFile(file, "utf8")).owner === owner)
        await unlink(file);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  };
}
export function diagnosticHtml(html: string): string {
  const $ = cheerio.load(html);
  $(
    "script, style, noscript, iframe, form, input, textarea, select, meta, link, img, svg",
  ).remove();
  $("*").each((_, element) => {
    for (const attr of Object.keys("attribs" in element ? element.attribs : {}))
      $(element).removeAttr(attr);
  });
  return redact($.root().html() ?? "").slice(0, 200_000);
}
async function snapshot(site: Website, html: string) {
  const directory = resolve(
    process.env.BROWSER_SNAPSHOT_DIR ?? ".local/browser-snapshots",
    site,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `${Date.now()}-${randomUUID()}.html`),
    diagnosticHtml(html),
    { mode: 0o600 },
  );
  const files = (await readdir(directory))
    .filter((f) => f.endsWith(".html"))
    .sort();
  for (const file of files.slice(0, Math.max(0, files.length - 20)))
    await rm(join(directory, file));
}
async function context(
  site: Website,
  headless: boolean,
): Promise<{ ctx: BrowserContext; release: () => Promise<void> }> {
  const profile = resolve(
    process.env[`${site.toUpperCase()}_PROFILE_DIR`] ??
      `.local/browser-profiles/${site}`,
  );
  const unlock = await profileLock(profile);
  try {
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const ctx = await chromium.launchPersistentContext(profile, {
      headless,
      ...(proxy ? { proxy: { server: proxy } } : {}),
      ...(executablePath ? { executablePath } : {}),
      viewport: { width: 1440, height: 1000 },
    });
    return {
      ctx,
      release: async () => {
        try {
          await ctx.close();
        } finally {
          await unlock();
        }
      },
    };
  } catch (e) {
    await unlock();
    throw e;
  }
}
export async function withBrowser<T>(
  db: PrismaClient,
  site: Website,
  sourceId: string,
  token: string,
  run: (session: SiteSession) => Promise<T>,
): Promise<T> {
  const { ctx, release } = await context(
    site,
    process.env.BROWSER_HEADLESS !== "false",
  );
  const page = await ctx.newPage();
  const timeout = positiveInt("BROWSER_TIMEOUT_MS", 30_000, 120_000);
  page.setDefaultTimeout(timeout);
  let leaseLost = false;
  const renew = async () => {
    const owned = await db.collectionSource.updateMany({
      where: {
        id: sourceId,
        leaseToken: token,
        leaseUntil: { gt: new Date() },
      },
      data: { leaseUntil: new Date(Date.now() + 30 * 60_000) },
    });
    if (!owned.count) {
      leaseLost = true;
      throw Error("Collection lease lost");
    }
  };
  const timer = setInterval(() => {
    renew().catch(() => {
      leaseLost = true;
      page.close().catch(() => {});
    });
  }, 60_000);
  const read = async (url: string) => {
    if (!allowedUrl(site, url))
      throw Error("Website URL outside configured provider");
    if (leaseLost) throw Error("Collection lease lost");
    await renew();
    await paceHost(db, sourceId, url);
    logEvent("info", "browser_navigation", { source: sourceId, url });
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      });
      if (!allowedUrl(site, page.url()))
        throw Error("Website redirected outside provider");
      if (response && (response.status() === 429 || response.status() >= 500)) {
        await applyCooldown(
          db,
          sourceId,
          url,
          response.headers()["retry-after"] ?? null,
        );
        throw Error(`Browser HTTP ${response.status()}`);
      }
      if (response && !response.ok())
        throw Error(`Browser HTTP ${response.status()}`);
      // Wait for provider data rather than the load event (trackers may never finish).
      await page.waitForFunction(
        (provider) => {
          const html = document.documentElement.innerHTML;
          const blocked =
            Boolean(
              document.querySelector("input[type=password], #challenge-form"),
            ) ||
            /captcha|security check|just a moment|access denied/i.test(
              document.title,
            );
          if (blocked) return true;
          if (provider === "indeed")
            return (
              html.includes("mosaic-provider-jobcards") ||
              html.includes("hostQueryExecutionResult") ||
              html.includes("application/ld+json")
            );
          if (provider === "wuzzuf") return html.includes("initialStoreState");
          if (provider === "linkedin")
            return Boolean(
              document.querySelector(
                "li[data-occludable-job-id], .base-card[data-entity-urn], .show-more-less-html__markup, .jobs-search-no-results-banner",
              ),
            );
          return Boolean(
            document.querySelector(
              'script[type="application/ld+json"], a[href*="/job/p/"], a[href*="/jobs/"]',
            ),
          );
        },
        site,
        { timeout },
      );
      const html = await page.content();
      if (blockedPage(html, page.url()))
        throw Error("Login or challenge requires manual browser-session setup");
      return html;
    } catch (e) {
      await snapshot(site, await page.content().catch(() => ""));
      throw e;
    }
  };
  try {
    return await run({
      read,
      linkedinDetails: async (
        url,
        selectors,
        maxDetails = 100,
        knownFullIds = new Set(),
      ) => {
        await read(url);
        // Load lazy cards before enumerating them; do not deduplicate against stored jobs.
        const cards = page.locator(selectors.cards!);
        const count = await cards.count();
        const result: {
          html: string;
          id: string;
          title: string;
          company: string;
          location: string;
        }[] = [];
        const indices: { index: number; id: string }[] = [];
        for (let index = 0; index < count; index++) {
          const card = cards.nth(index);
          const id =
            (await card.getAttribute("data-occludable-job-id")) ??
            (await card
              .locator("[data-job-id]")
              .first()
              .getAttribute("data-job-id"));
          if (!id || !/^\d+$/.test(id))
            throw Error("Missing LinkedIn card identity");
          indices.push({ index, id });
        }
        indices.sort(
          (a, b) =>
            Number(knownFullIds.has(a.id)) - Number(knownFullIds.has(b.id)),
        );
        let attempted = 0;
        for (const { index, id } of indices) {
          const card = cards.nth(index);
          await card.scrollIntoViewIfNeeded();
          const text = async (selector: string) =>
            (
              await card
                .locator(selector)
                .first()
                .textContent()
                .catch(() => "")
            )?.trim() ?? "";
          const title = await text(selectors.cardTitle!),
            company = await text(selectors.cardCompany!),
            location = await text(selectors.cardLocation!);
          if (attempted >= maxDetails) {
            result.push({ html: "", id, title, company, location });
            continue;
          }
          attempted++;
          await paceHost(db, sourceId, url);
          await card.click();
          // Require identity, title, company, and description hydration. Previous panel data must not leak.
          let html = "";
          try {
            await page.waitForFunction(
              ({
                identity,
                titleSelector,
                companySelector,
                expectedId,
                expectedTitle,
                expectedCompany,
                description,
              }) => {
                const anchor = document.querySelector(
                  identity,
                ) as HTMLAnchorElement | null;
                const match = anchor?.href.match(
                  /\/jobs\/view\/(?:[^/?]*-)?(\d+)(?:[/?]|$)/,
                );
                const normalized = (s: string) =>
                  s.replace(/\s+/g, " ").trim().toLowerCase();
                const actualTitle =
                  document.querySelector(titleSelector)?.textContent ?? "";
                const actualCompany =
                  document.querySelector(companySelector)?.textContent ?? "";
                return (
                  match?.[1] === expectedId &&
                  Boolean(
                    document.querySelector(description)?.textContent?.trim(),
                  ) &&
                  (!expectedTitle ||
                    normalized(actualTitle).includes(
                      normalized(
                        expectedTitle.replace(/\s*with verification\s*/i, ""),
                      ),
                    )) &&
                  (!expectedCompany ||
                    normalized(actualCompany) === normalized(expectedCompany))
                );
              },
              {
                identity: selectors.identity!,
                titleSelector: selectors.title!,
                companySelector: selectors.company!,
                expectedId: id,
                expectedTitle: title,
                expectedCompany: company,
                description: selectors.description!,
              },
              { timeout },
            );
            html = await page.content();
            if (blockedPage(html, page.url()))
              throw Error("LinkedIn session expired");
          } catch {
            await snapshot(
              site,
              await page.content().catch(() => ""),
            ); /* Preserve card as fallback; retry detail next run. */
          }
          result.push({ html, id, title, company, location });
          if (blockedPage(await page.content(), page.url())) break;
        }
        return result;
      },
    });
  } finally {
    clearInterval(timer);
    await release();
  }
}
// Interactive bootstrap only: users complete login/checkpoints themselves in a visible browser.
export async function browserSession(
  site: Website,
  url: string,
): Promise<void> {
  if (!allowedUrl(site, url)) throw Error("Invalid browser-session URL");
  const { ctx, release } = await context(site, false);
  try {
    const page = await ctx.newPage();
    await page.goto(
      site === "linkedin" ? "https://www.linkedin.com/login" : url,
      { waitUntil: "domcontentloaded" },
    );
    logEvent("info", "browser_session_waiting", {
      source: site,
      hint: "Complete login/challenge in the browser. Requires a desktop or DISPLAY; no credentials are logged.",
    });
    const deadline =
      Date.now() + positiveInt("BROWSER_SESSION_TIMEOUT_MS", 600_000, 1800_000);
    while (Date.now() < deadline) {
      if (page.isClosed())
        throw Error("Browser closed before session verification");
      const html = await page.content();
      const ready =
        site === "linkedin"
          ? /\/(feed|jobs)(?:[/?]|$)/.test(new URL(page.url()).pathname) &&
            (await page
              .locator(
                ".global-nav__me, #global-nav .global-nav__primary-link-me-menu-trigger",
              )
              .count()) > 0
          : !blockedPage(html, page.url()) &&
            allowedUrl(site, page.url()) &&
            (site === "indeed"
              ? html.includes("mosaic-provider-jobcards")
              : site === "wuzzuf"
                ? html.includes("initialStoreState")
                : Boolean(
                    await page
                      .locator(
                        'script[type="application/ld+json"], a[href*="/jobs/"], a[href*="/job/p/"]',
                      )
                      .count(),
                  ));
      if (ready) {
        logEvent("info", "browser_session_ready", { source: site });
        return;
      }
      await page.waitForTimeout(1000);
    }
    throw Error("Browser session setup timed out");
  } finally {
    await release();
  }
}
