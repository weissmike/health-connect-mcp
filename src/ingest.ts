import type { Env } from "./env.js";
import type { Normalized } from "./normalize.js";

// D1 allows 100 bound parameters per statement; a row uses 9. Batches count as one subrequest
// (free plan allows 50 per request), so cap total rows well under 50 batches of 100 statements.
const ROWS_PER_STATEMENT = 10;
const STATEMENTS_PER_BATCH = 100;
export const MAX_RECORDS_PER_REQUEST = 40_000;

const COLS = "(type,id,start_time,end_time,day,origin,last_modified,data,ingested_at)";
const UPSERT_TAIL =
  " ON CONFLICT(type,id) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time," +
  "day=excluded.day,origin=excluded.origin,last_modified=excluded.last_modified,data=excluded.data," +
  "ingested_at=excluded.ingested_at WHERE records.last_modified IS NULL OR excluded.last_modified IS NULL" +
  " OR excluded.last_modified >= records.last_modified";

export async function storeNormalized(env: Env, n: Normalized, now: string) {
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < n.records.length; i += ROWS_PER_STATEMENT) {
    const chunk = n.records.slice(i, i + ROWS_PER_STATEMENT);
    const sql = `INSERT INTO records ${COLS} VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")}${UPSERT_TAIL}`;
    const binds = chunk.flatMap((r) => [r.type, r.id, r.start, r.end, r.day, r.origin, r.lastModified, r.data, now]);
    statements.push(db.prepare(sql).bind(...binds));
  }
  for (const d of n.deletions) {
    statements.push(db.prepare("DELETE FROM records WHERE type=? AND id=?").bind(d.type, d.id));
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
  }

  await db.prepare("INSERT INTO ingest_log (received_at,app_version,timezone,types,upserted,deleted) VALUES (?,?,?,?,?,?)")
    .bind(now, n.appVersion, n.timezone, JSON.stringify(n.types), n.records.length, n.deletions.length).run();
  // Keep the log small.
  await db.prepare("DELETE FROM ingest_log WHERE received_at < ?")
    .bind(new Date(Date.parse(now) - 30 * 86_400_000).toISOString()).run();
}
