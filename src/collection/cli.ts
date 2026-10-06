import { logEvent } from "../logging.js";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { registry } from "./registry.js";
import { collect } from "./adapters.js";
import { claimSource, persistInventory, drainQueue } from "./engine.js";
import { requester } from "./request.js";
import { message } from "./notifications.js";
import { collectMarketplace } from "./marketplaces.js";
import type { Inventory, Target } from "./types.js";
import { sendTelegramMessage } from "../index.js";
import { formatTelegramMessage } from "../format.js";
export async function run(selected?: string, notify = false, force = false) {
  const r = await registry();
  const cronMinutes = process.env.CRON_EXPR?.match(
    /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/,
  )?.[1];
  if (cronMinutes)
    for (const t of r.targets)
      if (["mostaql", "khamsat", "ureed", "nafezly"].includes(t.provider))
        t.intervalHours = Number(cronMinutes) / 60;
  const targets = r.targets.filter(
    (t) =>
      t.status === "enabled" &&
      (!selected ||
        selected.split(",").includes(t.id) ||
        selected.split(",").includes(t.provider)),
  );
  if (selected && !targets.length)
    throw Error(`No enabled source matches ${selected}`);
  let index = 0;
  await Promise.all(
    [0, 1].map(async () => {
      while (index < targets.length) {
        const t = targets[index++]!;
        const token = await claimSource(prisma, t, force);
        if (!token) continue;
        const runRecord = await prisma.collectionRun.findUniqueOrThrow({
          where: { leaseToken: token },
          select: { id: true },
        });
        const started = Date.now();
        logEvent("info", "collection_started", {
          source: t.id,
          runId: runRecord.id,
        });
        let inv: Inventory;
        let streamedQueued = 0;
        try {
          if (["mostaql", "khamsat", "ureed", "nafezly"].includes(t.provider)) {
            inv = await collectMarketplace(t, requester(prisma, t.id, token));
          } else
            inv = await collect(
              t,
              requester(prisma, t.id, token),
              t.provider === "himalayas"
                ? async (batch) => {
                    streamedQueued += await persistInventory(
                      prisma,
                      t,
                      batch,
                      token,
                      false,
                    );
                  }
                : undefined,
            );
        } catch (e) {
          inv = {
            jobs: [],
            scope: "rolling-feed",
            complete: false,
            errors: [String(e)],
          };
        }
        const queued =
          streamedQueued + (await persistInventory(prisma, t, inv, token));
        logEvent(inv.complete ? "info" : "warn", "collection_finished", {
          source: t.id,
          runId: runRecord.id,
          jobs: inv.observedCount ?? inv.jobs.length,
          complete: inv.complete,
          errors: inv.errors,
          queued,
          durationMs: Date.now() - started,
        });
      }
    }),
  );
  if (notify)
    await drainQueue(prisma, sendTelegramMessage, (j) => {
      const t = r.targets.find((t) => t.id === j.source)!;
      if (j.listingKind === "marketplace")
        return formatTelegramMessage({
          ...j,
          skills: j.skills ? JSON.parse(j.skills) : [],
        });
      return message(
        {
          externalId: j.sourceProjectId,
          title: j.title,
          url: j.url,
          employer: j.employer ?? "",
          description: j.description ?? "",
          locations: JSON.parse(j.locations ?? "[]"),
          geographicRestrictions: JSON.parse(j.geographicRestrictions ?? "[]"),
          workplaceModel: j.workplaceModel ?? "unknown",
          timestampSemantics: j.timestampSemantics,
          qualityEvidence: {},
        },
        t,
      );
    });
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? "collect";
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  if (command === "status") {
    const r = await registry();
    console.log(
      JSON.stringify(
        {
          entities: r.entities.length,
          platformEntries: r.platformCatalogue.length,
          enabled: r.targets.filter((t) => t.status === "enabled").length,
          pendingEntities: r.entities.filter((e) => e.status !== "enabled")
            .length,
          targets: r.targets,
          health: await prisma.collectionSource.findMany(),
          recentRuns: await prisma.collectionRun.findMany({
            orderBy: { id: "desc" },
            take: 20,
          }),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "export") {
    const rows =
      option("--view") === "history"
        ? await prisma.jobVersion.findMany({ orderBy: { id: "asc" } })
        : await prisma.jobPost.findMany({ orderBy: { id: "asc" } });
    if (option("--format") === "csv") {
      const keys = Object.keys(rows[0] ?? {});
      const cell = (v: any) =>
        '"' +
        String(v instanceof Date ? v.toISOString() : (v ?? "")).replaceAll(
          '"',
          '""',
        ) +
        '"';
      console.log(keys.map(cell).join(","));
      for (const row of rows)
        console.log(keys.map((k) => cell((row as any)[k])).join(","));
    } else for (const row of rows) console.log(JSON.stringify(row));
    return;
  }
  if (command === "collect") {
    await run(
      option("--source"),
      args.includes("--notify"),
      args.includes("--force"),
    );
    return;
  }
  if (command === "schedule") {
    do {
      await run(undefined, args.includes("--notify"));
      await new Promise((r) => setTimeout(r, 60_000));
    } while (true);
  }
  throw Error(`Unknown command ${command}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .catch((e) => {
      logEvent("error", "fatal_error", { error: e });
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
