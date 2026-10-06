import { isTechJob } from "../filter.js";
import type { Job, Target } from "./types.js";
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const foreignCountries: string[] = [];
for (let a = 65; a <= 90; a++)
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const name = regionNames.of(code);
    if (code !== "EG" && name && name !== code)
      foreignCountries.push(name.toLowerCase());
  }
export function eligibility(job: Job): "confirmed" | "unverified" | "excluded" {
  const restrictions = job.geographicRestrictions ?? job.locations ?? [];
  const timezones = restrictions.filter((s) => s.startsWith("Timezone: "));
  if (
    timezones.length &&
    !timezones.some((s) => /^(?:Timezone: )(?:UTC)?\+?0?[23](?::00)?$/.test(s))
  )
    return "excluded";
  const locations = restrictions
    .filter((s) => !s.startsWith("Timezone: "))
    .join(" ");
  const body = job.description ?? "";
  if (
    /(?:must|only|required|restricted|based|resid(?:e|ent|ency)).{0,50}(?:united states|\bUSA\b|\bUS\b|canada|united kingdom|\bUK\b|european union|\bEU\b)/i.test(
      body,
    ) ||
    /(?:not|excluding).{0,15}egypt/i.test(body)
  )
    return "excluded";
  if (/egypt|cairo|alexandria|\bEG\b|مصر/i.test(locations)) return "confirmed";
  if (
    !/worldwide|anywhere|global/i.test(locations) &&
    /united states|\bUSA\b|\bUS\b|canada|\bCA\b|united kingdom|\bUK\b|australia|\bAU\b|europe(?:an union)?|\bEU\b/i.test(
      locations,
    )
  )
    return "excluded";
  const locationsWithoutCountries = foreignCountries.reduce(
    (value, country) => value.replaceAll(country, ""),
    locations.toLowerCase(),
  );
  if (
    !/worldwide|anywhere|global|EMEA|africa|middle east/i.test(
      locationsWithoutCountries,
    ) &&
    foreignCountries.some((country) =>
      locations.toLowerCase().includes(country),
    )
  )
    return "excluded";
  if (job.workplaceModel !== "remote") return "excluded";
  if (
    locations &&
    !/worldwide|anywhere|global|remote|EMEA|africa|middle east/i.test(locations)
  )
    return "excluded";
  return "unverified";
}
export function qualifies(job: Job, t: Target): boolean {
  const marketplace = ["mostaql", "khamsat", "ureed", "nafezly"].includes(
    t.provider,
  );
  return (
    isTechJob(
      {
        source: t.provider,
        title: job.title,
        description: marketplace ? (job.description ?? "") : "",
        category: job.category ?? "",
        skills: job.skills ?? [],
      },
      !["mostaql", "khamsat", "ureed", "nafezly"].includes(t.provider),
    ) &&
    (["mostaql", "khamsat", "ureed", "nafezly"].includes(t.provider) ||
      eligibility(job) !== "excluded")
  );
}
export function message(job: Job, t: Target): string {
  return [
    job.title,
    job.employer || t.employer,
    (job.locations ?? []).join(", "),
    eligibility(job) === "confirmed"
      ? "Egypt location confirmed"
      : "Egypt eligibility unverified",
    `Source: ${t.attribution}`,
    job.url,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 3000)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
