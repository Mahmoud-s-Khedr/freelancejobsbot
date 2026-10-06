import assert from "node:assert/strict";
import { registry } from "../src/collection/registry.js";
const r = await registry();
assert.equal(r.entities.length, 575);
assert.equal(new Set(r.entities.map((e) => e.id)).size, 575);
assert.equal(new Set(r.targets.map((t) => t.id)).size, r.targets.length);
for (const e of [...r.entities, ...r.platformCatalogue]) {
  assert.ok(e.status);
  assert.ok(e.status === "enabled" || e.pendingReason);
  if (e.targetId) assert.ok(r.targets.some((t) => t.id === e.targetId));
}
for (const t of r.targets) {
  assert.ok(t.evidence.length);
  if (
    t.status === "enabled" &&
    ["greenhouse", "ashby", "lever"].includes(t.provider)
  ) {
    assert.ok(
      t.evidence.some(
        (e: any) => e.provenance === "Validated complete payload",
      ),
    );
    assert.ok(t.evidence.some((e: any) => /Employer/.test(e.provenance)));
  }
}
console.log(
  JSON.stringify({
    entities: r.entities.length,
    platformAssessments: r.platformCatalogue.length,
    targets: r.targets.length,
    enabled: r.targets.filter((t) => t.status === "enabled").length,
    pendingEntities: r.entities.filter((e) => e.status !== "enabled").length,
    registryValidation: "passed",
  }),
);
