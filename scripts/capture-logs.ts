import "dotenv/config";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RotatingLogWriter, saveCursor } from "../src/logging.js";
const directory =
  process.env.LOG_DIR ?? join(homedir(), ".local/state/freelancebot/logs");
const writer = new RotatingLogWriter(
  directory,
  Number(process.env.LOG_MAX_BYTES ?? 10485760),
  Number(process.env.LOG_MAX_FILES ?? 30),
);
const cursorPath = join(directory, "journal.cursor");
const cursor = existsSync(cursorPath)
  ? readFileSync(cursorPath, "utf8").trim()
  : "";
const units = [
  "freelancebot.service",
  "freelancebot-baseline.service",
  "freelancebot-baseline-recovery.service",
];
const args = [
  "--user",
  "--follow",
  "--no-tail",
  "--output=json",
  ...units.flatMap((unit) => ["--unit", unit]),
  ...(cursor ? ["--after-cursor", cursor] : ["--since", "today"]),
];
const child = spawn("journalctl", args, {
  stdio: ["ignore", "pipe", "inherit"],
});
const completion = new Promise<number>((resolve, reject) => {
  child.once("exit", (code) => resolve(code ?? 1));
  child.once("error", reject);
});
const lines = createInterface({ input: child.stdout });
for await (const line of lines) {
  const entry = JSON.parse(line);
  const message =
    typeof entry.MESSAGE === "string"
      ? entry.MESSAGE
      : JSON.stringify(entry.MESSAGE);
  let details: Record<string, unknown> = { message };
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      details = parsed;
  } catch {}
  const tsUtc = new Date(
    Number(entry.__REALTIME_TIMESTAMP) / 1000,
  ).toISOString();
  writer.append({
    ...details,
    tsUtc: details.tsUtc ?? tsUtc,
    journalTsUtc: tsUtc,
    unit:
      entry._SYSTEMD_USER_UNIT ?? entry.USER_UNIT ?? entry.SYSLOG_IDENTIFIER,
    pid: entry._PID ?? details.pid,
    priority: entry.PRIORITY,
  });
  if (entry.__CURSOR) saveCursor(cursorPath, entry.__CURSOR);
}
const code = await completion;
if (code !== 0) throw Error(`Journal capture exited with status ${code}`);
