import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  errorDetails,
  redact,
  RotatingLogWriter,
  saveCursor,
} from "../src/logging.js";

test("logs redact configured secrets, Telegram URLs and bearer tokens", () => {
  const prior = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "777777:verySecret_token123";
  try {
    const output = redact(
      "bot777777:verySecret_token123/sendMessage token=777777:verySecret_token123 Bearer otherSecret",
    );
    assert.ok(!output.includes("verySecret"));
    assert.ok(!output.includes("otherSecret"));
    assert.match(output, /REDACTED/);
  } finally {
    if (prior === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prior;
  }
});
test("rotation, retention, restart appending and atomic cursor persistence", () => {
  const directory = mkdtempSync(join(tmpdir(), "freelancebot-logs-"));
  const day = new Date("2026-10-06T11:00:00Z");
  try {
    const writer = new RotatingLogWriter(directory, 100, 2);
    writer.append({ event: "first", text: "x".repeat(55) }, day);
    writer.append({ event: "second", text: "x".repeat(55) }, day);
    writer.append({ event: "third", text: "x".repeat(55) }, day);
    let files = readdirSync(directory)
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    assert.equal(files.length, 2);
    assert.equal(
      JSON.parse(readFileSync(join(directory, files[0]!), "utf8")).event,
      "second",
    );
    assert.equal(statSync(join(directory, files[0]!)).mode & 0o777, 0o600);
    new RotatingLogWriter(directory, 100, 2).append({ event: "restart" }, day);
    files = readdirSync(directory)
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    assert.equal(files.length, 2);
    assert.equal(
      JSON.parse(readFileSync(join(directory, files.at(-1)!), "utf8")).event,
      "restart",
    );
    saveCursor(join(directory, "journal.cursor"), "s=test-cursor");
    assert.equal(
      readFileSync(join(directory, "journal.cursor"), "utf8"),
      "s=test-cursor",
    );
    assert.equal(
      readdirSync(directory).filter((n) => n.endsWith(".tmp")).length,
      0,
    );
    writer.append({ event: "next-day" }, new Date("2026-10-07T00:00:00Z"));
    assert.equal(
      readdirSync(directory).filter((n) => n.endsWith(".jsonl")).length,
      2,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("network diagnostics retain stack and underlying connection cause", () => {
  const error = new Error("fetch failed", {
    cause: Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    }),
  });
  const details = errorDetails(error) as any;
  assert.match(details.stack, /fetch failed/);
  assert.equal(details.cause.code, "ECONNREFUSED");
});
