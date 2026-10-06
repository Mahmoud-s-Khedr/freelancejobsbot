import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function redact(value: string): string {
  let result = value
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  for (const [name, secret] of Object.entries(process.env)) {
    if (
      secret &&
      secret.length >= 4 &&
      /(?:TOKEN|SECRET|PASSWORD|API_KEY|TELEGRAM_CHAT_ID)$/.test(name)
    )
      result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}
export function errorDetails(value: unknown, depth = 0): unknown {
  if (value instanceof Error)
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...("code" in value ? { code: value.code } : {}),
      ...(value.cause && depth < 3
        ? { cause: errorDetails(value.cause, depth + 1) }
        : {}),
    };
  return value;
}
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown> = {},
): void {
  const line = JSON.stringify(
    {
      tsUtc: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      ...data,
    },
    (_key, value) => errorDetails(value),
  );
  console.error(redact(line));
}
export class RotatingLogWriter {
  private activeDate = "";
  private activePath = "";
  private bytes = 0;
  constructor(
    readonly directory: string,
    readonly maxBytes = 10 * 1024 * 1024,
    readonly maxFiles = 30,
  ) {
    if (
      !Number.isFinite(maxBytes) ||
      maxBytes < 1 ||
      !Number.isInteger(maxFiles) ||
      maxFiles < 1
    )
      throw Error("Invalid log rotation limits");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  append(record: unknown, now = new Date()): string {
    const day = now.toISOString().slice(0, 10);
    const line =
      redact(JSON.stringify(record, (_key, value) => errorDetails(value))) +
      "\n";
    const length = Buffer.byteLength(line);
    if (
      day !== this.activeDate ||
      !this.activePath ||
      (this.bytes > 0 && this.bytes + length > this.maxBytes)
    ) {
      const files = this.files().filter((name) =>
        name.startsWith(`freelancebot-${day}-`),
      );
      let sequence = files.length
        ? Number(files.at(-1)!.match(/-(\d+)\.jsonl$/)![1])
        : 1;
      let path = join(
        this.directory,
        `freelancebot-${day}-${String(sequence).padStart(6, "0")}.jsonl`,
      );
      let bytes = files.length ? statSync(path).size : 0;
      if (bytes > 0 && bytes + length > this.maxBytes) {
        sequence++;
        path = join(
          this.directory,
          `freelancebot-${day}-${String(sequence).padStart(6, "0")}.jsonl`,
        );
        bytes = 0;
      }
      this.activeDate = day;
      this.activePath = path;
      this.bytes = bytes;
    }
    appendFileSync(this.activePath, line, { mode: 0o600 });
    this.bytes += length;
    const files = this.files();
    for (const name of files.slice(
      0,
      Math.max(0, files.length - this.maxFiles),
    ))
      unlinkSync(join(this.directory, name));
    return this.activePath;
  }
  private files(): string[] {
    return readdirSync(this.directory)
      .filter((name) =>
        /^freelancebot-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(name),
      )
      .sort();
  }
}
export function saveCursor(path: string, cursor: string): void {
  writeFileSync(path + ".tmp", cursor, { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
