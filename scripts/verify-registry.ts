import { readFile, writeFile } from "node:fs/promises";
import { parsePayload } from "../src/collection/adapters.js";
import type { Target } from "../src/collection/types.js";
const path = new URL("../data/source-registry.json", import.meta.url);
const r = JSON.parse(await readFile(path, "utf8"));
const candidates = r.targets.filter(
  (t: Target) =>
    ["greenhouse", "ashby", "lever"].includes(t.provider) &&
    (!process.argv.includes("--pending") || t.status === "pending"),
);
let index = 0;
await Promise.all(
  [0, 1].map(async () => {
    while (index < candidates.length) {
      const t = candidates[index++];
      let association = false;
      try {
        const board = t.evidence
          .find((e: any) => e.role === "documented-api-listing")
          ?.provenance.match(/token from observed (https:\/\/\S+)/)?.[1];
        for (const u of (t.associationUrls ?? []).slice(0, 2)) {
          const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) continue;
          const html = await res.text();
          if (board && html.includes(board)) {
            association = true;
            t.evidence.push({
              url: u,
              board,
              provenance: "Employer page contains board URL",
              checkedAt: new Date().toISOString(),
            });
            break;
          }
          // Embedded API configuration or vacancy links to the same tenant also establish association.
          const host =
            t.provider === "greenhouse"
              ? "greenhouse.io"
              : t.provider === "ashby"
                ? "ashbyhq.com"
                : "lever.co";
          const escaped = t.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(
            `https?:[^\\s"'<>]{0,100}${host.replaceAll(".", "\\.")}[^\\s"'<>]{0,100}[/=]${escaped}(?:[/ ?"'<>]|$)`,
            "i",
          );
          if (regex.test(html)) {
            association = true;
            t.evidence.push({
              url: u,
              provenance: "Employer HTML includes tenant-qualified ATS link",
              checkedAt: new Date().toISOString(),
            });
            break;
          }
        }
        if (!association)
          throw Error("Employer association not confirmed by public HTML");
        const response = await fetch(t.url, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const inventory = parsePayload(t, await response.json());
        if (!inventory.complete || !inventory.jobs.length)
          throw Error(
            `Payload not verified: ${inventory.errors.join(",")} / ${inventory.jobs.length} jobs`,
          );
        t.status = "enabled";
        t.pendingReason = null;
        t.evidence.push({
          url: t.url,
          provenance: "Validated complete payload",
          jobs: inventory.jobs.length,
          checkedAt: new Date().toISOString(),
        });
      } catch (e) {
        t.status = "pending";
        t.pendingReason = String(e);
      }
      console.log(t.id, t.status, t.pendingReason ?? "");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }),
);
for (const e of r.entities) {
  const t = r.targets.find((t: Target) => t.id === e.targetId);
  e.status = t?.status ?? "pending";
  if (t) e.pendingReason = t.pendingReason;
}
await writeFile(path, JSON.stringify(r, null, 2) + "\n");
console.log(
  JSON.stringify({
    entities: r.entities.length,
    targets: r.targets.length,
    enabled: r.targets.filter((t: Target) => t.status === "enabled").length,
    pending: r.targets.filter((t: Target) => t.status !== "enabled").length,
    enabledEntities: r.entities.filter((e: any) => e.status === "enabled")
      .length,
  }),
);
