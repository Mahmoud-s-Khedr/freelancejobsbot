import { readFile } from "node:fs/promises";
import type { Target } from "./types.js";
export async function registry(): Promise<{
  entities: any[];
  platformCatalogue: any[];
  targets: Target[];
}> {
  return JSON.parse(
    await readFile(
      new URL("../../data/source-registry.json", import.meta.url),
      "utf8",
    ),
  );
}
