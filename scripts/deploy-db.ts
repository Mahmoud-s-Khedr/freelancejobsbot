import "dotenv/config";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
// Ensure SQLite's parent directory and empty file exist before the schema engine opens them.
const raw = process.env.DATABASE_URL;
if (!raw?.startsWith("file:") || !isAbsolute(raw.slice(5)))
  throw Error("db:deploy requires DATABASE_URL=file:/absolute/path/jobs.db");
const path = raw.slice(5);
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const file = await open(path, "a", 0o600);
await file.close();
const child = spawn(
  process.execPath,
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  { stdio: "inherit", env: process.env },
);
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
