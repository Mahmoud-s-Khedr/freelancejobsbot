import { logEvent } from "../logging.js";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { Inventory, Job, Target } from "./types.js";
import { qualifies } from "./notifications.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const leaseMs = 30 * 60_000;
export async function claimSource(
  db: PrismaClient,
  t: Target,
  force = false,
): Promise<string | null> {
  const now = new Date();
  await db.collectionSource.upsert({
    where: { id: t.id },
    create: { id: t.id },
    update: {},
  });
  const token = randomUUID();
  return db.$transaction(async (tx) => {
    if (
      (await tx.collectionSource.count({
        where: { leaseUntil: { gt: now } },
      })) >= 2
    )
      return null;
    const claimed = await tx.collectionSource.updateMany({
      where: {
        id: t.id,
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          { OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }] },
          ...(force
            ? []
            : [
                {
                  OR: [
                    { lastRunAt: null },
                    {
                      lastRunAt: {
                        lte: new Date(
                          now.getTime() - t.intervalHours * 3600_000,
                        ),
                      },
                    },
                  ],
                },
              ]),
        ],
      },
      data: {
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + leaseMs),
        lastRunAt: now,
      },
    });
    if (!claimed.count) return null;
    await tx.collectionRun.updateMany({
      where: { sourceId: t.id, finishedAt: null },
      data: {
        finishedAt: now,
        complete: false,
        errors: JSON.stringify(["Interrupted run; lease expired"]),
      },
    });
    await tx.collectionRun.create({
      data: {
        sourceId: t.id,
        leaseToken: token,
        scope: "not-yet-enumerated",
        errors: "[]",
      },
    });
    return token;
  });
}
export async function persistInventory(
  db: PrismaClient,
  t: Target,
  inv: Inventory,
  token: string,
  finalize = true,
): Promise<number> {
  const state = await db.collectionSource.findUniqueOrThrow({
    where: { id: t.id },
  });
  const run = await db.collectionRun.findUniqueOrThrow({
    where: { leaseToken: token },
  });
  const now = new Date();
  let queued = 0;
  const jobs = Array.from(
    new Map(inv.jobs.map((j) => [j.externalId, j])).values(),
  );
  // Each bounded batch commits jobs and their alerts together. Only the final
  // transaction establishes completeness, missing sightings, and the baseline.
  for (let offset = 0; offset < jobs.length; offset += 200) {
    await db.$transaction(
      async (tx) => {
        const owned = await tx.collectionSource.updateMany({
          where: {
            id: t.id,
            leaseToken: token,
            leaseUntil: { gt: new Date() },
          },
          data: { leaseUntil: new Date(Date.now() + leaseMs) },
        });
        if (!owned.count) throw Error("Collection lease lost");
        for (const job of jobs.slice(offset, offset + 200)) {
          const existing = await tx.jobPost.findUnique({
            where: {
              source_sourceProjectId: {
                source: t.id,
                sourceProjectId: job.externalId,
              },
            },
          });
          const rich = job.detailStatus !== "fallback";
          const content: Job =
            rich || !existing
              ? job
              : {
                  ...job,
                  description: existing.description ?? "",
                  qualityEvidence: job.qualityEvidence,
                };
          const data: any = {
            title: job.title,
            url: job.url,
            lastSeenAt: now,
            missingFromSourceAt: null,
          };
          if (rich || !existing)
            Object.assign(data, {
              description: job.description ?? null,
              rawText: job.description ?? null,
              applicationUrl: job.applicationUrl ?? null,
              employer: job.employer ?? t.employer,
              listingKind: ["mostaql", "khamsat", "ureed", "nafezly"].includes(
                t.provider,
              )
                ? "marketplace"
                : "employment",
              locations: JSON.stringify(job.locations ?? []),
              workplaceModel: job.workplaceModel ?? null,
              geographicRestrictions: JSON.stringify(
                job.geographicRestrictions ?? [],
              ),
              employmentType: job.employmentType ?? null,
              seniority: job.seniority ?? null,
              compensationCurrency: job.compensationCurrency ?? null,
              compensationPeriod: job.compensationPeriod ?? null,
              publishedAt: job.publishedAt ? new Date(job.publishedAt) : null,
              sourceUpdatedAt: job.sourceUpdatedAt
                ? new Date(job.sourceUpdatedAt)
                : null,
              timestampSemantics: job.timestampSemantics,
              qualityEvidence: JSON.stringify(job.qualityEvidence),
              category: job.category ?? null,
              skills: JSON.stringify(job.skills ?? []),
              budgetMin:
                job.budgetMin === undefined ? null : Math.round(job.budgetMin),
              budgetMax:
                job.budgetMax === undefined ? null : Math.round(job.budgetMax),
              budgetText: job.budgetText ?? null,
              status: job.status ?? null,
            });
          const row = existing
            ? await tx.jobPost.update({ where: { id: existing.id }, data })
            : await tx.jobPost.create({
                data: {
                  ...data,
                  source: t.id,
                  sourceProjectId: job.externalId,
                },
              });
          // Snapshot persisted values, so failed details cannot erase historical rich content.
          const {
            id,
            createdAt,
            updatedAt,
            lastSeenAt,
            missingFromSourceAt,
            sentAt,
            contentHash,
            ...snapshot
          } = row;
          const serialized = JSON.stringify(snapshot);
          const digest = hash(serialized);
          if (existing?.contentHash !== digest)
            await tx.jobVersion.create({
              data: { jobPostId: row.id, hash: digest, content: serialized },
            });
          await tx.jobPost.update({
            where: { id: row.id },
            data: { contentHash: digest },
          });
          await tx.jobSighting.upsert({
            where: { jobPostId_runId: { jobPostId: row.id, runId: run.id } },
            create: { jobPostId: row.id, runId: run.id },
            update: {},
          });
          const marketplace = [
            "mostaql",
            "khamsat",
            "ureed",
            "nafezly",
          ].includes(t.provider);
          if (
            !existing &&
            (state.baselineAt || marketplace) &&
            qualifies(content, t)
          ) {
            const duplicate = await tx.alertIdentity.findUnique({
              where: { url: job.applicationUrl ?? job.url },
            });
            if (!duplicate) {
              await tx.alertIdentity.create({
                data: { url: job.applicationUrl ?? job.url, jobPostId: row.id },
              });
              await tx.telegramQueue.create({ data: { jobPostId: row.id } });
              queued++;
            }
          }
        }
      },
      { timeout: 120_000 },
    );
  }
  if (!finalize) {
    await db.collectionRun.update({
      where: { id: run.id },
      data: { scope: inv.scope },
    });
    return queued;
  }
  await db.$transaction(async (tx) => {
    const owned = await tx.collectionSource.findUniqueOrThrow({
      where: { id: t.id },
    });
    if (
      owned.leaseToken !== token ||
      !owned.leaseUntil ||
      owned.leaseUntil < new Date()
    )
      throw Error("Collection lease lost");
    await tx.collectionRun.update({
      where: { id: run.id },
      data: {
        scope: inv.scope,
        complete: inv.complete,
        errors: JSON.stringify(inv.errors),
        finishedAt: new Date(),
      },
    });

    if (inv.complete && inv.scope === "full-board")
      await tx.jobPost.updateMany({
        where: {
          source: t.id,
          sightings: { none: { runId: run.id } },
          missingFromSourceAt: null,
        },
        data: { missingFromSourceAt: now },
      });
    await tx.collectionSource.update({
      where: { id: t.id },
      data: inv.complete
        ? {
            baselineAt: state.baselineAt ?? now,
            lastSuccessAt: now,
            failures: 0,
            cooldownUntil: null,
            leaseToken: null,
            leaseUntil: null,
          }
        : {
            failures: { increment: 1 },
            cooldownUntil: new Date(
              Math.max(
                state.cooldownUntil?.getTime() ?? 0,
                now.getTime() +
                  Math.min(24 * 3600_000, 300_000 * 2 ** state.failures),
              ),
            ),
            leaseToken: null,
            leaseUntil: null,
          },
    });
  });
  return queued;
}

export async function drainQueue(
  db: PrismaClient,
  send: (text: string) => Promise<void>,
  format: (job: any) => string,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const token = randomUUID();
    const item = await db.$transaction(async (tx) => {
      const now = new Date();
      const where = {
        failedAt: null,
        attempts: { lt: 5 },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      };
      const candidate = await tx.telegramQueue.findFirst({
        where,
        include: { jobPost: true },
        orderBy: { id: "asc" },
      });
      if (!candidate) return null;
      const claim = await tx.telegramQueue.updateMany({
        where: { id: candidate.id, ...where },
        data: {
          leaseToken: token,
          leaseUntil: new Date(now.getTime() + 5 * 60_000),
          attempts: { increment: 1 },
        },
      });
      return claim.count ? candidate : null;
    });
    if (!item) return;
    logEvent("info", "telegram_delivery_claimed", {
      queueId: item.id,
      jobId: item.jobPostId,
      source: item.jobPost.source,
      attempt: item.attempts + 1,
    });
    try {
      await send(format(item.jobPost));
      await db.$transaction(async (tx) => {
        const owned = await tx.telegramQueue.deleteMany({
          where: { id: item.id, leaseToken: token },
        });
        if (owned.count)
          await tx.jobPost.update({
            where: { id: item.jobPostId },
            data: { sentAt: new Date() },
          });
      });
      logEvent("info", "telegram_delivery_sent", {
        queueId: item.id,
        jobId: item.jobPostId,
        source: item.jobPost.source,
        attempt: item.attempts + 1,
      });
    } catch (error) {
      logEvent(
        item.attempts >= 4 ? "error" : "warn",
        "telegram_delivery_failed",
        {
          queueId: item.id,
          jobId: item.jobPostId,
          source: item.jobPost.source,
          attempt: item.attempts + 1,
          terminal: item.attempts >= 4,
          error,
        },
      );
      await db.telegramQueue.updateMany({
        where: { id: item.id, leaseToken: token },
        data: {
          leaseToken: null,
          leaseUntil: new Date(Date.now() + 60_000),
          ...(item.attempts >= 4 ? { failedAt: new Date() } : {}),
        },
      });
    }
  }
}
