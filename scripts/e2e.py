"""End-to-end check with simulated Health Connect data (tagged test.simulated.*).

  E2E_BASE=http://127.0.0.1:8787 E2E_OWNER=<MCP_BEARER> E2E_INGEST=<INGEST_TOKEN> python scripts/e2e.py

Run it against `wrangler dev --local` (the data stays in the local database). Against a deployed Worker it writes
test rows into your real database; purge them afterwards with
  npx wrangler d1 execute <db> --remote --command "DELETE FROM records WHERE origin LIKE 'test.simulated.%'"
Note: the local dev server must be started with a config whose __ORIGIN__ is its own http://127.0.0.1:<port>,
because OAuth token audiences are checked against the server's origin.
"""
import json, pathlib, time, urllib.error, urllib.request

import os
OWNER = os.environ["E2E_OWNER"]
INGEST = os.environ["E2E_INGEST"]
BASE = os.environ["E2E_BASE"].rstrip("/")
UA = {"User-Agent": "hc-e2e/1.0"}


def http(method, path, body=None, token=None, raw=None):
    h = dict(UA)
    data = None
    if raw is not None:
        data = raw.encode(); h["Content-Type"] = "application/json"
    elif body is not None:
        data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
    if token:
        h["Authorization"] = "Bearer " + token
    h["Accept"] = "application/json, text/event-stream"
    for attempt in range(8):
        req = urllib.request.Request(BASE + path, data, h, method=method)
        try:
            r = urllib.request.urlopen(req, timeout=25)
            return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(8)
    raise SystemExit("network: could not reach " + BASE)


def mcp(tool, args=None):
    s, b = http("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args or {}}}, OWNER)
    line = [l[6:] for l in b.splitlines() if l.startswith("data: ")]
    d = json.loads(line[0] if line else b)
    r = d.get("result", d)
    txt = r["content"][0]["text"]
    try:
        return json.loads(txt)
    except ValueError:
        return txt


# wait for deploy to serve the new routes
for _ in range(10):
    s, b = http("GET", "/health")
    if s == 200 and "readOnly" in b:
        s2, _ = http("POST", "/ingest", {"x": 1})
        if s2 == 401:
            break
    time.sleep(6)

print("1 no token ->", http("POST", "/ingest", {"weight": []})[0])
print("2 wrong token ->", http("POST", "/ingest", {"weight": []}, "nope")[0])
print("3 owner token on /ingest (must fail) ->", http("POST", "/ingest", {"weight": []}, OWNER)[0])
print("4 bad json ->", http("POST", "/ingest", raw="{not json", token=INGEST)[0])
print("5 not an object ->", http("POST", "/ingest", raw="[1,2]", token=INGEST)[0])

O1, O2 = "test.simulated.scale", "test.simulated.watch"
payload = {
    "timestamp": "2026-11-09T12:00:00-05:00", "app_version": "e2e", "timezone": "America/Detroit",
    "weight": [
        {"kilograms": 90.0, "time": "2026-11-01T07:00:00-04:00", "metadata": {"id": "t-w1", "data_origin": O1, "last_modified_time": "2026-11-01T07:01:00-04:00"}},
        {"kilograms": 89.0, "time": "2026-11-08T07:00:00-05:00", "metadata": {"id": "t-w2", "data_origin": O1, "last_modified_time": "2026-11-08T07:01:00-05:00"}},
        {"kilograms": 70.0, "time": "2026-11-05T07:00:00-05:00", "metadata": {"id": "t-w-del", "data_origin": O1}},
    ],
    "body_fat": [{"percentage": 21.5, "time": "2026-11-08T07:00:00-05:00", "metadata": {"id": "t-bf1", "data_origin": O1}}],
    "steps": [
        {"count": 4000, "start_time": "2026-11-08T08:00:00-05:00", "end_time": "2026-11-08T12:00:00-05:00", "metadata": {"id": "t-s1", "data_origin": O1}},
        {"count": 3000, "start_time": "2026-11-08T12:00:00-05:00", "end_time": "2026-11-08T18:00:00-05:00", "metadata": {"id": "t-s2", "data_origin": O1}},
        {"count": 9000, "start_time": "2026-11-08T00:00:00-05:00", "end_time": "2026-11-08T23:00:00-05:00", "metadata": {"id": "t-s3", "data_origin": O2}},
    ],
    "sleep": [{"session_end_time": "2026-11-08T06:30:00-05:00", "duration_seconds": 25200, "metadata": {"id": "t-sl1", "data_origin": O2},
               "stages": [{"stage": "DEEP", "start_time": "2026-11-07T23:30:00-05:00", "end_time": "2026-11-08T00:30:00-05:00", "duration_seconds": 3600},
                          {"stage": "REM", "start_time": "2026-11-08T00:30:00-05:00", "end_time": "2026-11-08T01:30:00-05:00", "duration_seconds": 3600}]}],
}
s, b = http("POST", "/ingest", payload, INGEST)
print("6 ingest ->", s, b[:200])
s, b = http("POST", "/ingest", payload, INGEST)
print("7 re-send identical ->", s, "(must not duplicate)")

st = mcp("get_sync_status")
print("8 status types:", {t["type"]: t["records"] for t in st["types"] if any(x["app"].startswith("test.") for x in t["sources"])})
w = mcp("get_weight_history", {"start": "2026-10-25", "end": "2026-11-09"})
print("9 weight:", w["count"], "readings; latest lb", w["summary"]["latest"]["lb"], "| change lb", w["summary"]["change_lb"])
print("10 body fat:", mcp("get_body_fat", {"start": "2026-11-01", "end": "2026-11-09"})["readings"])
print("11 steps:", json.dumps(mcp("get_steps", {"start": "2026-11-08", "end": "2026-11-08"})["days"]))
sl = mcp("get_sleep", {"start": "2026-11-08", "end": "2026-11-08"})["sessions"]
print("12 sleep:", [(x["date"], x["hours"], x["stage_minutes"]) for x in sl])
ds = mcp("get_daily_summary", {"date": "2026-11-08"})
print("13 daily summary:", {k: ds[k] for k in ("date", "record_counts")})
gr = mcp("get_records", {"type": "weight", "start": "2026-10-25", "end": "2026-11-09", "source": O1})
print("14 get_records weight by source:", gr["count"])

# edit (newer last_modified) and delete
edit = {"weight": [{"kilograms": 88.0, "time": "2026-11-08T07:00:00-05:00", "metadata": {"id": "t-w2", "data_origin": O1, "last_modified_time": "2026-11-08T09:00:00-05:00"}}],
        "deleted": [{"type": "weight", "id": "t-w-del"}]}
print("15 edit+delete ->", http("POST", "/ingest", edit, INGEST)[0])
stale = {"weight": [{"kilograms": 50.0, "time": "2026-11-08T07:00:00-05:00", "metadata": {"id": "t-w2", "data_origin": O1, "last_modified_time": "2026-11-08T08:00:00-05:00"}}]}
print("16 stale re-send ->", http("POST", "/ingest", stale, INGEST)[0], "(older last_modified must not overwrite)")
w = mcp("get_weight_history", {"start": "2026-10-25", "end": "2026-11-09"})
print("17 weight after edit/delete/stale:", [(r["time"][:10], r["kg"]) for r in w["readings"]])
print("18 /mcp unauthenticated ->", http("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})[0])
