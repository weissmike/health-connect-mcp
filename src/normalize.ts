/** Pure helpers: turn a Health Connect webhook payload into rows. No I/O. */

export type NormRecord = {
  type: string;
  id: string;
  start: string;
  end: string;
  day: string;
  origin: string | null;
  lastModified: string | null;
  data: string;
};
export type Deletion = { type: string; id: string };
export type Normalized = {
  records: NormRecord[];
  deletions: Deletion[];
  appVersion: string | null;
  timezone: string | null;
  types: Record<string, number>;
  skipped: number;
};

const META_KEYS = new Set(["timestamp", "app_version", "timezone", "deleted"]);
const TYPE_RE = /^[a-z0-9_]{1,64}$/;
const MAX_RECORD_JSON = 100_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const validIso = (v: string | undefined): v is string => v !== undefined && !Number.isNaN(Date.parse(v));

/** Start of a record: explicit start/time, else first stage, else end minus duration. */
export function startOf(r: Record<string, unknown>): string | undefined {
  const direct = str(r.start_time) ?? str(r.time) ?? str(r.date) ?? str(r.start);
  if (validIso(direct)) return direct;
  const stages = Array.isArray(r.stages) ? r.stages : [];
  const first = isObj(stages[0]) ? str(stages[0].start_time) : undefined;
  if (validIso(first)) return first;
  const end = str(r.session_end_time) ?? str(r.end_time);
  const dur = typeof r.duration_seconds === "number" ? r.duration_seconds : undefined;
  if (validIso(end) && dur !== undefined) return new Date(Date.parse(end) - dur * 1000).toISOString();
  return validIso(end) ? end : undefined;
}

export function endOf(r: Record<string, unknown>, start: string): string {
  const end = str(r.end_time) ?? str(r.session_end_time) ?? str(r.time);
  return validIso(end) ? end : start;
}

/** YYYY-MM-DD from an ISO string as sent (local date if the sender used local time). */
export function dayOf(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
}

export function normalizePayload(payload: unknown): Normalized {
  if (!isObj(payload)) throw new Error("Payload must be a JSON object");
  const out: Normalized = {
    records: [],
    deletions: [],
    appVersion: str(payload.app_version) ?? null,
    timezone: str(payload.timezone) ?? null,
    types: {},
    skipped: 0,
  };
  const received = str(payload.timestamp) ?? null;

  for (const [type, value] of Object.entries(payload)) {
    if (META_KEYS.has(type) || !Array.isArray(value)) continue;
    if (!TYPE_RE.test(type)) { out.skipped += value.length; continue; }
    for (const item of value) {
      if (!isObj(item)) { out.skipped++; continue; }
      const start = startOf(item);
      if (!start) { out.skipped++; continue; }
      const end = endOf(item, start);
      const meta = isObj(item.metadata) ? item.metadata : {};
      const id = str(meta.id) ?? str(item.id) ?? `agg:${start}:${end}`;
      let data = JSON.stringify(item);
      if (data.length > MAX_RECORD_JSON) {
        data = JSON.stringify({ truncated: true, original_bytes: data.length, keys: Object.keys(item) });
      }
      // Sleep belongs to the day you wake up.
      const isSleep = type.includes("sleep");
      out.records.push({
        type, id, start, end,
        day: dayOf(isSleep ? end : start),
        origin: str(meta.data_origin) ?? null,
        lastModified: str(meta.last_modified_time) ?? received,
        data,
      });
      out.types[type] = (out.types[type] ?? 0) + 1;
    }
  }

  if (Array.isArray(payload.deleted)) {
    for (const d of payload.deleted) {
      if (isObj(d) && str(d.type) && str(d.id) && TYPE_RE.test(str(d.type)!)) {
        out.deletions.push({ type: str(d.type)!, id: str(d.id)! });
      }
    }
  }
  return out;
}

/** Sleep stage minutes by stage name, from a raw sleep record. */
export function sleepStageMinutes(r: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of Array.isArray(r.stages) ? r.stages : []) {
    if (!isObj(st)) continue;
    const name = String(st.stage ?? "UNKNOWN").toUpperCase();
    const secs = typeof st.duration_seconds === "number" ? st.duration_seconds
      : validIso(str(st.start_time)) && validIso(str(st.end_time)) ? (Date.parse(str(st.end_time)!) - Date.parse(str(st.start_time)!)) / 1000 : 0;
    out[name] = Math.round(((out[name] ?? 0) + secs / 60) * 10) / 10;
  }
  return out;
}
