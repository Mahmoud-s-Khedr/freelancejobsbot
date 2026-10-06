import { parsePayload } from "../src/collection/adapters.js";
import { registry } from "../src/collection/registry.js";
const t = (await registry()).targets.find((t) => t.id === "himalayas")!;
const first = await (
  await fetch(t.url, { signal: AbortSignal.timeout(15000) })
).json();
const inv = parsePayload(t, first);
console.log(
  JSON.stringify({
    jobs: inv.jobs.length,
    payloadValid: inv.complete,
    nextCursor: typeof first.nextCursor === "string",
    scope: "two-page bounded smoke; not full enumeration",
  }),
);
if (first.nextCursor) {
  const u = new URL(t.url);
  u.searchParams.set("cursor", first.nextCursor);
  await new Promise((r) => setTimeout(r, 1000));
  const second = parsePayload(
    t,
    await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json(),
  );
  console.log(
    JSON.stringify({
      secondPageJobs: second.jobs.length,
      payloadValid: second.complete,
    }),
  );
}
