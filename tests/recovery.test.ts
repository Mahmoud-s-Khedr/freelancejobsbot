import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import {
  claimSource,
  persistInventory,
  drainQueue,
  retryFailedQueue,
} from "../src/collection/engine.js";
import { isTechJob } from "../src/filter.js";
import type { Target, Job } from "../src/collection/types.js";
async function isolated(run: (db: PrismaClient) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "recovery-test-")),
    path = join(dir, "db");
  const sql = new Database(path);
  for (const m of readdirSync("prisma/migrations")
    .filter((m) => m !== "migration_lock.toml")
    .sort())
    sql.exec(readFileSync(`prisma/migrations/${m}/migration.sql`, "utf8"));
  sql.close();
  const db = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${path}` }),
  });
  try {
    await run(db);
  } finally {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}
const target: Target = {
  id: "mostaql",
  provider: "mostaql",
  url: "https://mostaql.com/projects",
  employer: "",
  entityIds: [],
  evidence: [],
  status: "enabled",
  pendingReason: null,
  attribution: "Mostaql",
  intervalHours: 1,
  restrictions: "",
};
const job: Job = {
  externalId: "1",
  title: "Build a business site",
  url: "https://mostaql.com/project/1",
  description: "Details unavailable",
  detailStatus: "fallback",
  timestampSemantics: "unknown",
  qualityEvidence: {},
};
async function save(db: PrismaClient, t: Target, jobs: Job[]) {
  const token = await claimSource(db, t, true);
  assert.ok(token);
  return persistInventory(
    db,
    t,
    { jobs, scope: "rolling-feed", complete: true, errors: [] },
    token,
  );
}
test("recovered fallback details queue once, and rich content survives subsequent failures", async () =>
  isolated(async (db) => {
    assert.equal(await save(db, target, [job]), 0);
    assert.equal((await db.jobPost.findFirstOrThrow()).deferredAlert, true);
    const rich = {
      ...job,
      detailStatus: "full",
      description: "Develop using React and TypeScript",
      skills: ["React"],
    };
    assert.equal(await save(db, target, [rich]), 1);
    assert.equal(await save(db, target, [rich]), 0);
    assert.equal(await save(db, target, [job]), 0);
    const row = await db.jobPost.findFirstOrThrow();
    assert.equal(row.description, rich.description);
    assert.equal(row.detailStatus, "full");
    assert.equal(row.deferredAlert, false);
    assert.equal(await db.telegramQueue.count(), 1);
  }));
test("silent baseline recovery and ordinary edits do not produce retroactive alerts", async () =>
  isolated(async (db) => {
    const t = { ...target, id: "indeed", provider: "indeed" as const };
    const fallback = {
      ...job,
      locations: ["Egypt"],
      url: "https://eg.indeed.com/viewjob?jk=1",
    };
    await save(db, t, [fallback]);
    assert.equal((await db.jobPost.findFirstOrThrow()).deferredAlert, false);
    await save(db, t, [
      { ...fallback, title: "Software developer", detailStatus: "full" },
    ]);
    assert.equal(await db.telegramQueue.count(), 0);
    const next = {
      ...fallback,
      externalId: "2",
      url: "https://eg.indeed.com/viewjob?jk=2",
    };
    await save(db, t, [next]);
    assert.equal(
      await save(db, t, [
        {
          ...next,
          description: "React",
          title: "Software developer",
          detailStatus: "full",
        },
      ]),
      1,
    );
    const nonTech = {
      ...next,
      externalId: "3",
      url: "https://eg.indeed.com/viewjob?jk=3",
      detailStatus: "full",
    };
    await save(db, t, [nonTech]);
    await save(db, t, [{ ...nonTech, title: "Software developer" }]);
    assert.equal(await db.telegramQueue.count(), 1);
  }));
test("exhausted crash claims become visible failures; explicit retry preserves active leases", async () =>
  isolated(async (db) => {
    await save(db, target, [job]);
    const row = await db.jobPost.findFirstOrThrow();
    const item = await db.telegramQueue.create({
      data: {
        jobPostId: row.id,
        attempts: 5,
        leaseToken: "crashed",
        leaseUntil: new Date(0),
      },
    });
    let sent = 0;
    await drainQueue(
      db,
      async () => {
        sent++;
      },
      () => "mock",
    );
    assert.equal(sent, 0);
    assert.ok((await db.telegramQueue.findFirstOrThrow()).failedAt);
    assert.equal(await retryFailedQueue(db, item.id), 1);
    await drainQueue(
      db,
      async () => {
        sent++;
      },
      () => "mock",
    );
    assert.equal(sent, 1);
    assert.equal(await db.telegramQueue.count(), 0);
    const active = await db.telegramQueue.create({
      data: {
        jobPostId: row.id,
        attempts: 5,
        leaseToken: "active",
        leaseUntil: new Date(Date.now() + 300_000),
      },
    });
    assert.equal(await retryFailedQueue(db, active.id), 0);
    await drainQueue(
      db,
      async () => {
        sent++;
      },
      () => "mock",
    );
    assert.equal(sent, 1);
    assert.equal((await db.telegramQueue.findFirstOrThrow()).failedAt, null);
  }));
test("WordPress jobs match while Word data-entry jobs remain excluded", () => {
  assert.equal(
    isTechJob({ source: "mostaql", title: "WordPress developer" }),
    true,
  );
  assert.equal(
    isTechJob({ source: "khamsat", title: "WordPress plugin development" }),
    true,
  );
  assert.equal(
    isTechJob({ source: "indeed", title: "Word data entry with Python" }),
    false,
  );
});

test("relative publication estimates stay stable on unchanged refreshes", async () =>
  isolated(async (db) => {
    const t = { ...target, id: "linkedin", provider: "linkedin" as const };
    const estimated: Job = {
      ...job,
      title: "Software developer",
      locations: ["Egypt"],
      detailStatus: "full",
      timestampSemantics: "estimated-relative-publication",
      publishedAt: "2026-10-05T12:00:00Z",
      qualityEvidence: {
        rawPublishedAt: "2 days ago",
        observedAt: "2026-10-07T12:00:00Z",
      },
    };
    await save(db, t, [estimated]);
    const versions = await db.jobVersion.count();
    await save(db, t, [
      {
        ...estimated,
        publishedAt: "2026-10-05T13:00:00Z",
        qualityEvidence: {
          rawPublishedAt: "2 days ago",
          observedAt: "2026-10-07T13:00:00Z",
        },
      },
    ]);
    assert.equal(
      (await db.jobPost.findFirstOrThrow()).publishedAt?.toISOString(),
      "2026-10-05T12:00:00.000Z",
    );
    assert.equal(await db.jobVersion.count(), versions);
    await save(db, t, [
      {
        ...estimated,
        timestampSemantics: "source-publication",
        publishedAt: "2026-10-05T11:30:00Z",
      },
    ]);
    assert.equal(
      (await db.jobPost.findFirstOrThrow()).publishedAt?.toISOString(),
      "2026-10-05T11:30:00.000Z",
    );
  }));
