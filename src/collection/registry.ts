import { readFile } from "node:fs/promises";
import type { Target } from "./types.js";
export async function registry(): Promise<{
  entities: any[];
  platformCatalogue: any[];
  targets: Target[];
}> {
  const result = JSON.parse(
    await readFile(
      new URL("../../data/source-registry.json", import.meta.url),
      "utf8",
    ),
  );
  for (const target of result.targets) {
    if (
      ![
        "indeed",
        "linkedin",
        "wuzzuf",
        "forasna",
        "bayt",
        "wellfound",
      ].includes(target.provider)
    )
      continue;
    const prefix = target.provider.toUpperCase();
    if (process.env[`${prefix}_SEARCH_URL`])
      target.url = process.env[`${prefix}_SEARCH_URL`];
    if (process.env[`${prefix}_ENABLED`] === "true") target.status = "enabled";
    if (process.env[`${prefix}_ENABLED`] === "false")
      target.status = "disabled";
  }
  return result;
}
