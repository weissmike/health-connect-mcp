import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dayOf, normalizePayload, sleepStageMinutes, startOf } from "../src/normalize.ts";

// Shape taken from the HC Webhook docs (docs/webhook.md).
const payload = {
  timestamp: "2026-05-09T18:04:56.789+05:30",
  app_version: "1.9.28",
  timezone: "Asia/Kolkata",
  steps: [{ count: 8421, start_time: "2026-05-08T18:30:00+05:30", end_time: "2026-05-09T18:30:00+05:30" }],
  weight: [{
    kilograms: 74.2, time: "2026-05-09T07:10:00+05:30",
    metadata: { data_origin: "com.example.scale", id: "3f2a9c1e", last_modified_time: "2026-05-09T07:11:02+05:30", zone_offset_seconds: 19800 },
  }],
  sleep: [{
    session_end_time: "2026-05-09T06:50:00+05:30", duration_seconds: 25200,
    stages: [
      { stage: "DEEP", start_time: "2026-05-09T00:30:00+05:30", end_time: "2026-05-09T01:15:00+05:30", duration_seconds: 2700 },
      { stage: "LIGHT", start_time: "2026-05-09T01:15:00+05:30", end_time: "2026-05-09T02:15:00+05:30", duration_seconds: 3600 },
      { stage: "DEEP", start_time: "2026-05-09T02:15:00+05:30", end_time: "2026-05-09T02:45:00+05:30", duration_seconds: 1800 },
    ],
  }],
  deleted: [{ type: "weight", id: "old-1" }, { type: "BAD TYPE", id: "x" }, { id: "missing-type" }],
};

describe("normalizePayload", () => {
  const n = normalizePayload(payload);

  test("maps every record type and ignores metadata keys", () => {
    assert.deepEqual(n.types, { steps: 1, weight: 1, sleep: 1 });
    assert.equal(n.appVersion, "1.9.28");
    assert.equal(n.timezone, "Asia/Kolkata");
    assert.equal(n.skipped, 0);
  });

  test("uses metadata.id when present, a synthetic key for aggregates", () => {
    const w = n.records.find((r) => r.type === "weight");
    assert.equal(w.id, "3f2a9c1e");
    assert.equal(w.origin, "com.example.scale");
    assert.equal(w.lastModified, "2026-05-09T07:11:02+05:30");
    const s = n.records.find((r) => r.type === "steps");
    assert.equal(s.id, "agg:2026-05-08T18:30:00+05:30:2026-05-09T18:30:00+05:30");
    assert.equal(s.origin, null);
  });

  test("day comes from the sender's own date; sleep is dated by wake day", () => {
    assert.equal(n.records.find((r) => r.type === "weight").day, "2026-05-09");
    assert.equal(n.records.find((r) => r.type === "steps").day, "2026-05-08");
    const sleep = n.records.find((r) => r.type === "sleep");
    assert.equal(sleep.day, "2026-05-09");
    assert.equal(sleep.start, "2026-05-09T00:30:00+05:30"); // first stage start
  });

  test("keeps only well-formed deletions", () => {
    assert.deepEqual(n.deletions, [{ type: "weight", id: "old-1" }]);
  });

  test("re-sending the same aggregate yields the same id (idempotent upsert)", () => {
    const again = normalizePayload(payload);
    assert.equal(again.records.find((r) => r.type === "steps").id, n.records.find((r) => r.type === "steps").id);
  });

  test("rejects non-objects and skips records without usable times", () => {
    assert.throws(() => normalizePayload([]));
    const x = normalizePayload({ weight: [{ kilograms: 70 }, "junk"], "Bad-Type": [{ time: "2026-01-01" }] });
    assert.equal(x.records.length, 0);
    assert.equal(x.skipped, 3);
  });

  test("oversized records are replaced by a stub, not dropped", () => {
    const big = { time: "2026-01-02T00:00:00Z", samples: "x".repeat(150_000) };
    const x = normalizePayload({ heart_rate: [big] });
    assert.equal(x.records.length, 1);
    assert.equal(JSON.parse(x.records[0].data).truncated, true);
  });
});

describe("helpers", () => {
  test("startOf derives sleep start from end minus duration when stages are absent", () => {
    const s = startOf({ session_end_time: "2026-05-09T06:00:00Z", duration_seconds: 3600 });
    assert.equal(s, "2026-05-09T05:00:00.000Z");
  });
  test("dayOf keeps the local date in an offset timestamp", () => {
    assert.equal(dayOf("2026-05-09T23:30:00-04:00"), "2026-05-09");
  });
  test("sleepStageMinutes sums per stage", () => {
    assert.deepEqual(sleepStageMinutes(payload.sleep[0]), { DEEP: 75, LIGHT: 60 });
  });
});
