import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { sleepStageMinutes } from "./normalize.js";

const KG_TO_LB = 2.2046226218;
const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const output = (value: unknown, isError = false) => ({
  isError,
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const run = async (op: () => Promise<unknown>) => {
  try { return output(await op()); }
  catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
};

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = (start?: string, end?: string, defaultDays = 30) => {
  const e = end ?? today();
  return { start: start ?? addDays(e, -defaultDays), end: e };
};
const parse = (s: unknown): Record<string, unknown> => {
  try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return {}; }
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function createMcpServer(env: Env): McpServer {
  const db = env.DB;
  const server = new McpServer({ name: "health-connect-mcp", version: "0.1.0" }, {
    instructions:
      "Read-only access to Android Health Connect data synced from the owner's phone by a webhook app. Start with get_sync_status to see which record types, source apps and date ranges exist. Weights are returned in kg and lb. Dates are YYYY-MM-DD in the sender's timezone; sleep is dated by the day you woke up.",
  });

  server.tool(
    "get_sync_status",
    "What data exists: per record type the count, earliest and latest record, last sync time, and which apps wrote it, plus the most recent syncs. Use this first, and to check the phone is still syncing.",
    {},
    () => run(async () => {
      const types = await db.prepare(
        "SELECT type, COUNT(*) AS records, MIN(start_time) AS first_record, MAX(start_time) AS latest_record, MAX(ingested_at) AS last_synced FROM records GROUP BY type ORDER BY type",
      ).all();
      const origins = await db.prepare("SELECT type, origin, COUNT(*) AS records FROM records GROUP BY type, origin ORDER BY type, records DESC").all();
      const syncs = await db.prepare("SELECT received_at, app_version, timezone, types, upserted, deleted FROM ingest_log ORDER BY received_at DESC LIMIT 5").all();
      const byType: Record<string, unknown[]> = {};
      for (const o of origins.results as Array<{ type: string; origin: string | null; records: number }>) {
        (byType[o.type] ??= []).push({ app: o.origin ?? "unknown", records: o.records });
      }
      return {
        types: (types.results as Array<Record<string, unknown>>).map((t) => ({ ...t, sources: byType[String(t.type)] ?? [] })),
        recent_syncs: (syncs.results as Array<Record<string, unknown>>).map((s) => ({ ...s, types: parse(s.types) })),
      };
    }),
  );

  server.tool(
    "get_records",
    "Raw records of any type (steps, weight, body_fat, sleep, heart_rate, nutrition, exercise, hydration, ...), newest first. Use get_sync_status to see the type names. Each record includes the source app.",
    {
      type: z.string().regex(/^[a-z0-9_]{1,64}$/),
      start: dateArg.optional().describe("First day (default: 30 days ago)"),
      end: dateArg.optional().describe("Last day (default: today)"),
      source: z.string().optional().describe("Only records written by this app (data origin package name)"),
      limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
    },
    ({ type, start, end, source, limit }) => run(async () => {
      const r = range(start, end);
      const q = source
        ? db.prepare("SELECT start_time,end_time,origin,data FROM records WHERE type=? AND day>=? AND day<=? AND origin=? ORDER BY start_time DESC LIMIT ?").bind(type, r.start, r.end, source, limit ?? 50)
        : db.prepare("SELECT start_time,end_time,origin,data FROM records WHERE type=? AND day>=? AND day<=? ORDER BY start_time DESC LIMIT ?").bind(type, r.start, r.end, limit ?? 50);
      const rows = (await q.all()).results as Array<{ start_time: string; end_time: string; origin: string | null; data: string }>;
      return { type, from: r.start, to: r.end, count: rows.length, records: rows.map((x) => ({ start: x.start_time, end: x.end_time, source: x.origin, ...parse(x.data) })) };
    }),
  );

  server.tool(
    "get_weight_history",
    "Body weight readings (kg and lb) oldest to newest with min, max and change over the range, plus which app recorded each.",
    { start: dateArg.optional().describe("Default: 90 days ago"), end: dateArg.optional().describe("Default: today") },
    ({ start, end }) => run(async () => {
      const r = range(start, end, 90);
      const rows = (await db.prepare(
        "SELECT start_time, origin, data FROM records WHERE type='weight' AND day>=? AND day<=? ORDER BY start_time ASC LIMIT 1000",
      ).bind(r.start, r.end).all()).results as Array<{ start_time: string; origin: string | null; data: string }>;
      const readings = rows.flatMap((x) => {
        const d = parse(x.data);
        const kg = num(d.kilograms) ?? num(d.weight_kg) ?? num(d.value);
        return kg === null ? [] : [{ time: x.start_time, kg: round(kg, 2), lb: round(kg * KG_TO_LB, 1), source: x.origin }];
      });
      const kgs = readings.map((x) => x.kg);
      return {
        from: r.start, to: r.end, count: readings.length,
        summary: readings.length ? {
          first: readings[0], latest: readings[readings.length - 1],
          change_lb: round(readings[readings.length - 1]!.lb - readings[0]!.lb, 1),
          min_lb: round(Math.min(...kgs) * KG_TO_LB, 1), max_lb: round(Math.max(...kgs) * KG_TO_LB, 1),
        } : null,
        readings,
      };
    }),
  );

  server.tool(
    "get_body_fat",
    "Body fat percentage readings oldest to newest with the source app.",
    { start: dateArg.optional().describe("Default: 90 days ago"), end: dateArg.optional().describe("Default: today") },
    ({ start, end }) => run(async () => {
      const r = range(start, end, 90);
      const rows = (await db.prepare(
        "SELECT start_time, origin, data FROM records WHERE type='body_fat' AND day>=? AND day<=? ORDER BY start_time ASC LIMIT 1000",
      ).bind(r.start, r.end).all()).results as Array<{ start_time: string; origin: string | null; data: string }>;
      return {
        from: r.start, to: r.end,
        readings: rows.flatMap((x) => {
          const d = parse(x.data);
          const pct = num(d.percentage) ?? num(d.percent) ?? num(d.value);
          return pct === null ? [] : [{ time: x.start_time, percent: round(pct, 1), source: x.origin }];
        }),
      };
    }),
  );

  server.tool(
    "get_sleep",
    "Sleep sessions dated by wake-up day: start, end, hours asleep and minutes per stage (deep, light, REM, awake) where the source provides stages.",
    { start: dateArg.optional().describe("Default: 14 days ago"), end: dateArg.optional().describe("Default: today") },
    ({ start, end }) => run(async () => {
      const r = range(start, end, 14);
      const rows = (await db.prepare(
        "SELECT day, start_time, end_time, origin, data FROM records WHERE type LIKE '%sleep%' AND day>=? AND day<=? ORDER BY start_time ASC LIMIT 500",
      ).bind(r.start, r.end).all()).results as Array<{ day: string; start_time: string; end_time: string; origin: string | null; data: string }>;
      return {
        from: r.start, to: r.end,
        sessions: rows.map((x) => {
          const d = parse(x.data);
          const secs = num(d.duration_seconds) ?? (Date.parse(x.end_time) - Date.parse(x.start_time)) / 1000;
          return { date: x.day, start: x.start_time, end: x.end_time, hours: round(secs / 3600, 2), stage_minutes: sleepStageMinutes(d), source: x.origin };
        }),
      };
    }),
  );

  server.tool(
    "get_steps",
    "Daily step totals. Phones and watches can both record steps, so totals are given per source app, plus the largest single source as best_total (summing sources would double count).",
    { start: dateArg.optional().describe("Default: 14 days ago"), end: dateArg.optional().describe("Default: today") },
    ({ start, end }) => run(async () => {
      const r = range(start, end, 14);
      const rows = (await db.prepare(
        "SELECT day, origin, SUM(COALESCE(json_extract(data,'$.count'), json_extract(data,'$.steps'), 0)) AS steps FROM records WHERE type='steps' AND day>=? AND day<=? GROUP BY day, origin ORDER BY day ASC",
      ).bind(r.start, r.end).all()).results as Array<{ day: string; origin: string | null; steps: number }>;
      const days = new Map<string, Array<{ source: string; steps: number }>>();
      for (const x of rows) (days.get(x.day) ?? days.set(x.day, []).get(x.day)!).push({ source: x.origin ?? "unknown", steps: Math.round(x.steps) });
      return {
        from: r.start, to: r.end,
        days: [...days].map(([date, by_source]) => ({ date, best_total: Math.max(...by_source.map((s) => s.steps)), by_source })),
      };
    }),
  );

  server.tool(
    "get_daily_summary",
    "Everything recorded for one day: record counts per type, steps per source, weight readings, and the sleep that ended that day.",
    { date: dateArg.optional().describe("Default: today") },
    ({ date }) => run(async () => {
      const day = date ?? today();
      const counts = (await db.prepare("SELECT type, COUNT(*) AS records FROM records WHERE day=? GROUP BY type ORDER BY type").bind(day).all()).results;
      const steps = (await db.prepare("SELECT origin, SUM(COALESCE(json_extract(data,'$.count'), json_extract(data,'$.steps'), 0)) AS steps FROM records WHERE type='steps' AND day=? GROUP BY origin").bind(day).all()).results as Array<{ origin: string | null; steps: number }>;
      const weights = (await db.prepare("SELECT start_time, origin, data FROM records WHERE type='weight' AND day=? ORDER BY start_time").bind(day).all()).results as Array<{ start_time: string; origin: string | null; data: string }>;
      const sleep = (await db.prepare("SELECT start_time, end_time, data FROM records WHERE type LIKE '%sleep%' AND day=? ORDER BY start_time").bind(day).all()).results as Array<{ start_time: string; end_time: string; data: string }>;
      return {
        date: day,
        record_counts: counts,
        steps_by_source: steps.map((s) => ({ source: s.origin ?? "unknown", steps: Math.round(s.steps) })),
        weights: weights.flatMap((w) => { const kg = num(parse(w.data).kilograms); return kg === null ? [] : [{ time: w.start_time, kg: round(kg, 2), lb: round(kg * KG_TO_LB, 1), source: w.origin }]; }),
        sleep: sleep.map((s) => { const d = parse(s.data); const secs = num(d.duration_seconds) ?? (Date.parse(s.end_time) - Date.parse(s.start_time)) / 1000; return { start: s.start_time, end: s.end_time, hours: round(secs / 3600, 2), stage_minutes: sleepStageMinutes(d) }; }),
      };
    }),
  );

  return server;
}
