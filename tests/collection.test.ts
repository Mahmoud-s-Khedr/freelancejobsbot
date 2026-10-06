import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  parsePayload,
  collect,
  sanitizeHtml,
} from "../src/collection/adapters.js";
import {
  claimSource,
  persistInventory,
  drainQueue,
} from "../src/collection/engine.js";
import {
  eligibility,
  message,
  qualifies,
} from "../src/collection/notifications.js";
import type { Target, Job, Inventory } from "../src/collection/types.js";
const target: Target = {
  id: "greenhouse:test:tenant",
  provider: "greenhouse",
  url: "https://test/jobs",
  employer: "Example",
  entityIds: ["E1"],
  evidence: [],
  status: "enabled",
  pendingReason: null,
  attribution: "Example",
  intervalHours: 6,
  restrictions: "",
};
const job: Job = {
  externalId: "1",
  title: "Software developer",
  url: "https://example.com/jobs/1",
  description: "Build software",
  locations: ["Remote"],
  workplaceModel: "remote",
  timestampSemantics: "unknown",
  qualityEvidence: {},
};
const inventory = (jobs: Job[], complete = true): Inventory => ({
  jobs,
  scope: "full-board",
  complete,
  errors: complete ? [] : ["interrupted"],
});
test("ATS payload validation and timestamp semantics", () => {
  const inv = parsePayload(target, {
    jobs: [
      {
        id: 1,
        title: "Accountant",
        absolute_url: job.url,
        updated_at: "2026-01-01",
        location: { name: "Cairo" },
      },
    ],
  });
  assert.equal(inv.jobs.length, 1);
  assert.equal(inv.jobs[0]!.publishedAt, undefined);
  assert.equal(inv.jobs[0]!.sourceUpdatedAt, "2026-01-01T00:00:00.000Z");
  assert.throws(() => parsePayload(target, {}));
  assert.equal(parsePayload(target, { jobs: [] }).complete, true);
  assert.equal(parsePayload(target, { jobs: [{}] }).complete, false);
  const ashby = parsePayload(
    { ...target, provider: "ashby" },
    { jobs: [{ id: "a", title: "Role", jobUrl: job.url, publishedAt: "bad" }] },
  );
  assert.equal(ashby.jobs[0]!.publishedAt, undefined);
  const lever = parsePayload({ ...target, provider: "lever" }, [
    { id: "x", text: "Role", hostedUrl: job.url, createdAt: 0 },
  ]);
  assert.equal(lever.jobs[0]!.publishedAt, "1970-01-01T00:00:00.000Z");
});
test("feeds, XML, missing fields, and Himalayas country objects", () => {
  for (const provider of ["remotive", "himalayas", "remoteok"] as const) {
    const row = {
      id: 1,
      title: "Role",
      url: job.url,
      locationRestrictions: [{ alpha2: "EG", name: "Egypt" }],
      minSalary: 100,
      currency: "EGP",
    };
    const inv = parsePayload(
      { ...target, provider },
      provider === "remoteok" ? [{ legal: "notice" }, row] : { jobs: [row] },
    );
    assert.equal(inv.jobs.length, 1);
    if (provider === "himalayas") {
      assert.deepEqual(inv.jobs[0]!.locations, ["Egypt"]);
      assert.equal(inv.jobs[0]!.compensationCurrency, "EGP");
    }
  }
  const rss =
    "<rss><channel><item><guid>1</guid><title>A &amp; B</title><link>https://example.com/1</link></item></channel></rss>";
  assert.equal(
    parsePayload({ ...target, provider: "wwr" }, rss).jobs[0]!.title,
    "A & B",
  );
  assert.throws(() =>
    parsePayload({ ...target, provider: "wwr" }, "<html>blocked</html>"),
  );
  assert.equal(
    sanitizeHtml("<meta><h1>Job</h1><script>secret</script><p>Text</p>"),
    "JobText",
  );
});
test("cursor interruption never becomes complete; blocked and malformed responses fail", async () => {
  let count = 0;
  const inv = await collect({ ...target, provider: "himalayas" }, async () => {
    if (count++) throw Error("429");
    return JSON.stringify({
      jobs: [{ guid: "x", title: "Role", applicationLink: job.url }],
      nextCursor: "next",
    });
  });
  assert.equal(inv.jobs.length, 1);
  assert.equal(inv.complete, false);
  const bad = await collect(target, async () => "<html>challenge</html>");
  assert.equal(bad.complete, false);
  const repeated = await collect(
    { ...target, provider: "himalayas" },
    async () => JSON.stringify({ jobs: [], nextCursor: "same" }),
  );
  assert.equal(repeated.complete, false);
});
test("Egypt eligibility, exclusions and attribution", () => {
  assert.equal(eligibility(job), "unverified");
  assert.match(message(job, target), /Egypt eligibility unverified/);
  assert.match(message(job, target), /Source: Example/);
  assert.equal(
    eligibility({ ...job, locations: ["United States"] }),
    "excluded",
  );
  assert.equal(
    eligibility({ ...job, locations: ["Cairo, Egypt"] }),
    "confirmed",
  );
  assert.equal(
    eligibility({ ...job, description: "Must be based in the United States" }),
    "excluded",
  );
});
test("migrations, baseline recovery, histories, tenant IDs, duplicate alerts and queue leases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freelancebot-"));
  const path = join(dir, "isolated.db");
  const sqlite = new Database(path);
  const migrations = readdirSync("prisma/migrations")
    .filter((n) => n !== "migration_lock.toml")
    .sort();
  for (const migration of migrations.filter((n) => !n.includes("collection")))
    sqlite.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  sqlite.exec(
    `INSERT INTO JobPost(id,source,sourceProjectId,title,url,publishedAt,updatedAt) VALUES(77,'nafezly','old','Legacy','https://legacy.test',12345,12345);INSERT INTO TelegramQueue(id,jobPostId) VALUES(88,77)`,
  );
  sqlite.exec(
    readFileSync(
      `prisma/migrations/${migrations.find((n) => n.includes("collection"))}/migration.sql`,
      "utf8",
    ),
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT jobPostId FROM TelegramQueue WHERE id=88")
        .get() as any
    ).jobPostId,
    77,
  );
  assert.equal(
    (sqlite.prepare("SELECT publishedAt FROM JobPost WHERE id=77").get() as any)
      .publishedAt,
    12345,
  );
  assert.match(
    (
      sqlite
        .prepare("SELECT qualityEvidence FROM JobPost WHERE id=77")
        .get() as any
    ).qualityEvidence,
    /discovery/,
  );
  sqlite.close();
  const db = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${path}` }),
  });
  try {
    await db.telegramQueue.deleteMany();
    const save = async (t: Target, inv: Inventory) => {
      await db.collectionSource.updateMany({
        where: { id: t.id },
        data: { cooldownUntil: null },
      });
      const token = await claimSource(db, t, true);
      assert.ok(token);
      return persistInventory(db, t, inv, token);
    };
    await save(target, inventory([job], false));
    assert.equal(await db.telegramQueue.count(), 0);
    await save(target, inventory([job]));
    assert.equal(await db.telegramQueue.count(), 0);
    assert.equal(
      await save(
        target,
        inventory([
          job,
          { ...job, externalId: "2", url: "https://example.com/2" },
        ]),
      ),
      1,
    );
    await save(
      target,
      inventory([
        {
          ...job,
          title: "Edited developer",
          description: "Rich updated detail",
        },
        { ...job, externalId: "2", url: "https://example.com/2" },
      ]),
    );
    assert.equal(await db.telegramQueue.count(), 1);
    await save(
      target,
      inventory(
        [
          {
            ...job,
            title: "Edited developer",
            description: "fallback",
            detailStatus: "fallback",
          },
        ],
        false,
      ),
    );
    const current = await db.jobPost.findFirstOrThrow({
      where: { source: target.id, sourceProjectId: "1" },
    });
    assert.equal(current.description, "Rich updated detail");
    assert.equal(current.missingFromSourceAt, null);
    await save(target, inventory([]));
    assert.ok(
      (await db.jobPost.findUniqueOrThrow({ where: { id: current.id } }))
        .missingFromSourceAt,
    );
    assert.equal(
      (await db.jobPost.findUniqueOrThrow({ where: { id: current.id } }))
        .status,
      null,
    );
    const other = { ...target, id: "greenhouse:test:other" };
    await save(other, inventory([]));
    await save(
      other,
      inventory([{ ...job, externalId: "2", url: "https://example.com/2" }]),
    );
    assert.equal(await db.telegramQueue.count(), 1);
    assert.equal(
      await db.jobPost.count({ where: { sourceProjectId: "2" } }),
      2,
    );
    assert.ok(
      (await db.jobVersion.count({ where: { jobPostId: current.id } })) >= 2,
    );
    let delivered = 0;
    const send = async () => {
      delivered++;
      await new Promise((r) => setTimeout(r, 20));
    };
    await Promise.all([
      drainQueue(db, send, () => "mock"),
      drainQueue(db, send, () => "mock"),
    ]);
    assert.equal(delivered, 1);
    assert.equal(await db.telegramQueue.count(), 0);
    const lease = await claimSource(db, target, true);
    assert.ok(lease);
    assert.equal(await claimSource(db, target, true), null);
    const secondLease = await claimSource(
      db,
      { ...target, id: "second-running" },
      true,
    );
    assert.ok(secondLease);
    assert.equal(
      await claimSource(db, { ...target, id: "third-running" }, true),
      null,
    );
    await db.collectionSource.update({
      where: { id: "second-running" },
      data: { leaseUntil: new Date(0) },
    });
    await db.collectionSource.update({
      where: { id: target.id },
      data: { leaseUntil: new Date(0) },
    });
    assert.ok(await claimSource(db, target, true));
    const interrupted = await db.collectionRun.findUniqueOrThrow({
      where: { leaseToken: lease },
    });
    assert.match(interrupted.errors, /Interrupted/);
    assert.equal(interrupted.complete, false);
    await db.telegramQueue.create({
      data: { jobPostId: current.id, attempts: 4 },
    });
    let failures = 0;
    await drainQueue(
      db,
      async () => {
        failures++;
        throw Error("mock delivery failure");
      },
      () => "mock",
    );
    assert.equal(failures, 1);
    assert.ok((await db.telegramQueue.findFirstOrThrow()).failedAt);
    await db.telegramQueue.deleteMany();
    await db.collectionSource.update({
      where: { id: target.id },
      data: { leaseUntil: new Date(0) },
    });
    await save(
      other,
      inventory([
        { ...job, externalId: "repost", url: "https://example.com/2" },
      ]),
    );
    assert.equal(await db.telegramQueue.count(), 0);
    assert.equal(await db.jobPost.count({ where: { source: other.id } }), 2);
    const before = await db.jobVersion.count({
      where: { jobPostId: current.id },
    });
    await save(target, inventory([job]));
    assert.ok(
      (await db.jobVersion.count({ where: { jobPostId: current.id } })) >
        before,
    );
    await save(
      target,
      inventory([
        {
          ...job,
          externalId: "3",
          title: "Accountant",
          description: "Accounting",
          url: "https://example.com/3",
        },
        {
          ...job,
          externalId: "4",
          locations: ["Remote - US"],
          url: "https://example.com/4",
        },
      ]),
    );
    assert.equal(await db.telegramQueue.count(), 0);
    assert.equal(
      await db.jobPost.count({
        where: { source: target.id, sourceProjectId: { in: ["3", "4"] } },
      }),
      2,
    );
  } finally {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("tracked synthetic fixtures cover six JSON adapters", () => {
  const fixtures = JSON.parse(
    readFileSync("tests/fixtures/collection/payloads.json", "utf8"),
  );
  for (const provider of [
    "greenhouse",
    "ashby",
    "lever",
    "himalayas",
    "remotive",
    "remoteok",
  ] as const) {
    const inv = parsePayload({ ...target, provider }, fixtures[provider]);
    assert.equal(inv.complete, true);
    assert.equal(inv.jobs.length, 1);
  }
  assert.equal(eligibility({ ...job, locations: ["Remote - US"] }), "excluded");
  assert.equal(
    eligibility({ ...job, geographicRestrictions: ["Timezone: -08:00"] }),
    "excluded",
  );
  assert.equal(
    eligibility({ ...job, geographicRestrictions: ["Timezone: +02:00"] }),
    "unverified",
  );
});

test("marketplace disable preference does not disable employer tech matching", () => {
  const prior = process.env.ENABLE_TECH_FILTER;
  process.env.ENABLE_TECH_FILTER = "false";
  try {
    const nonTech = { ...job, title: "Accountant", description: "Accounting" };
    assert.equal(qualifies(nonTech, { ...target, provider: "mostaql" }), true);
    assert.equal(qualifies(nonTech, target), false);
    assert.equal(
      eligibility({ ...job, locations: ["Remote - India"] }),
      "excluded",
    );
  } finally {
    if (prior === undefined) delete process.env.ENABLE_TECH_FILTER;
    else process.env.ENABLE_TECH_FILTER = prior;
  }
});
test("interrupted batch persistence retains evidence and cannot establish a baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freelancebot-batches-"));
  const path = join(dir, "isolated.db");
  const sqlite = new Database(path);
  for (const name of readdirSync("prisma/migrations")
    .filter((n) => n !== "migration_lock.toml")
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"),
    );
  sqlite.close();
  const db = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${path}` }),
  });
  const rows = Array.from({ length: 202 }, (_, i) => ({
    ...job,
    externalId: String(i),
    url: `https://example.com/batch/${i}`,
  }));
  const original = db.$transaction.bind(db);
  try {
    const token = await claimSource(db, target, true);
    assert.ok(token);
    let batches = 0;
    (db.$transaction as any) = async (...args: any[]) => {
      if (++batches === 2) throw Error("simulated interruption");
      return (original as any)(...args);
    };
    await assert.rejects(
      persistInventory(db, target, inventory(rows), token, false),
      /interruption/,
    );
    (db.$transaction as any) = original;
    assert.equal(await db.jobPost.count(), 200);
    assert.equal(await db.telegramQueue.count(), 0);
    assert.equal(
      (
        await db.collectionSource.findUniqueOrThrow({
          where: { id: target.id },
        })
      ).baselineAt,
      null,
    );
    assert.equal(
      (
        await db.collectionRun.findUniqueOrThrow({
          where: { leaseToken: token },
        })
      ).complete,
      false,
    );
    await db.collectionSource.update({
      where: { id: target.id },
      data: { leaseUntil: new Date(0) },
    });
    const retry = await claimSource(db, target, true);
    assert.ok(retry);
    await persistInventory(db, target, inventory(rows), retry);
    assert.equal(await db.jobPost.count(), 202);
    assert.equal(await db.telegramQueue.count(), 0);
    assert.ok(
      (
        await db.collectionSource.findUniqueOrThrow({
          where: { id: target.id },
        })
      ).baselineAt,
    );
  } finally {
    (db.$transaction as any) = original;
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed rows retain valid rows, and Ashby salary semantics are explicit", () => {
  const inv = parsePayload(target, {
    jobs: [null, { id: 1, title: "Role", absolute_url: job.url }],
  });
  assert.equal(inv.jobs.length, 1);
  assert.equal(inv.complete, false);
  const ashby = parsePayload(
    { ...target, provider: "ashby" },
    {
      jobs: [
        {
          id: "a",
          title: "Developer",
          jobUrl: job.url,
          secondaryLocations: [{ location: "Egypt" }],
          workplaceType: "Remote",
          compensation: {
            summaryComponents: [
              {
                compensationType: "Salary",
                minValue: 20000,
                maxValue: 30000,
                currencyCode: "EGP",
                interval: "1 MONTH",
              },
            ],
          },
        },
      ],
    },
  );
  assert.deepEqual(ashby.jobs[0]!.locations, ["Egypt"]);
  assert.equal(ashby.jobs[0]!.workplaceModel, "remote");
  assert.equal(ashby.jobs[0]!.compensationCurrency, "EGP");
  assert.equal(ashby.jobs[0]!.compensationPeriod, "1 MONTH");
  assert.equal(ashby.jobs[0]!.budgetMin, 20000);
});
test("Himalayas streams bounded batches and preserves enumeration completeness", async () => {
  let page = 0;
  const saved: number[] = [];
  const inv = await collect(
    { ...target, provider: "himalayas" },
    async () => {
      const offset = page++ * 20;
      return JSON.stringify({
        jobs: Array.from({ length: 20 }, (_, i) => ({
          guid: String(offset + i),
          title: "Software developer",
          applicationLink: `https://example.com/${offset + i}`,
        })),
        ...(page < 12 ? { nextCursor: String(page) } : {}),
      });
    },
    async (batch) => {
      saved.push(batch.jobs.length);
      assert.equal(batch.complete, false);
    },
  );
  assert.deepEqual(saved, [200]);
  assert.equal(inv.jobs.length, 40);
  assert.equal(inv.observedCount, 240);
  assert.equal(inv.complete, true);
});

test("South Africa is a country restriction, while Africa remains uncertain eligibility", () => {
  assert.equal(
    eligibility({ ...job, locations: ["Remote - South Africa"] }),
    "excluded",
  );
  assert.equal(eligibility({ ...job, locations: ["Africa"] }), "unverified");
});

test("employer tech matching ignores incidental tools in nontechnical descriptions", () => {
  assert.equal(
    qualifies(
      {
        ...job,
        title: "Freelance Copywriter",
        description: "Use GitHub, APIs, and WordPress",
      },
      target,
    ),
    false,
  );
  assert.equal(
    qualifies(
      { ...job, title: "Software Developer", description: "Build services" },
      target,
    ),
    true,
  );
});
