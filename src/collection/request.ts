import { randomUUID } from "node:crypto";
import { logEvent } from "../logging.js";
import type { PrismaClient } from "../generated/prisma/client.js";
const hosts = new Map<string, Promise<unknown>>();
export function requester(
  db: PrismaClient,
  sourceId: string,
  leaseToken?: string,
) {
  return async (url: string, init?: RequestInit): Promise<string> => {
    const host = new URL(url).hostname;
    const previous = hosts.get(host) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        if (leaseToken) {
          const renewed = await db.collectionSource.updateMany({
            where: { id: sourceId, leaseToken },
            data: { leaseUntil: new Date(Date.now() + 30 * 60_000) },
          });
          if (!renewed.count) throw Error("Collection lease lost");
        }
        const delay = await db.$transaction(async (tx) => {
          const state = await tx.requestHost.upsert({
            where: { host },
            create: { host, nextRequestAt: new Date() },
            update: {},
          });
          if (state.cooldownUntil && state.cooldownUntil > new Date())
            throw Error(
              `Host cooldown until ${state.cooldownUntil.toISOString()}`,
            );
          const next = Math.max(Date.now(), state.nextRequestAt.getTime());
          await tx.requestHost.update({
            where: { host },
            data: { nextRequestAt: new Date(next + 1000) },
          });
          return next - Date.now();
        });
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        const requestId = randomUUID();
        const started = Date.now();
        logEvent("info", "http_request_started", {
          source: sourceId,
          requestId,
          url,
          method: init?.method ?? "GET",
        });
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(15_000),
          headers: {
            "User-Agent": "freelancebot/1.0 (personal job research)",
            Accept: "application/json, application/rss+xml, text/xml",
            ...init?.headers,
          },
        });
        logEvent(response.ok ? "info" : "warn", "http_response", {
          source: sourceId,
          requestId,
          url,
          status: response.status,
          durationMs: Date.now() - started,
          retryAfter: response.headers.get("retry-after"),
        });
        if (!response.ok) {
          const retry = response.headers.get("retry-after");
          const seconds = Number(retry);
          const until = retry
            ? Number.isFinite(seconds)
              ? Date.now() + seconds * 1000
              : Date.parse(retry)
            : Date.now() + 300_000;
          const cooldownUntil = new Date(
            Math.max(Date.now() + 300_000, Number.isFinite(until) ? until : 0),
          );
          await db.collectionSource.updateMany({
            where: { id: sourceId },
            data: { cooldownUntil },
          });
          if (response.status === 429 || response.status >= 500)
            await db.requestHost.update({
              where: { host },
              data: { cooldownUntil },
            });
          throw Error(`HTTP ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw Error("Missing response body");
        let length = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 20_000_000) {
            await reader.cancel();
            throw Error("Response too large");
          }
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
      })
      .catch((error) => {
        logEvent("error", "http_request_failed", {
          source: sourceId,
          url,
          method: init?.method ?? "GET",
          error,
        });
        throw error;
      });
    hosts.set(host, task);
    return task;
  };
}
