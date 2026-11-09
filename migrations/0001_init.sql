-- Health Connect records pushed by the Android webhook app, one row per record.
CREATE TABLE IF NOT EXISTS records (
  type          TEXT NOT NULL,          -- e.g. weight, steps, sleep, heart_rate
  id            TEXT NOT NULL,          -- Health Connect metadata.id (or a synthetic key for aggregates)
  start_time    TEXT NOT NULL,          -- ISO 8601 exactly as sent
  end_time      TEXT,
  day           TEXT NOT NULL,          -- YYYY-MM-DD taken from the start (wake day for sleep)
  origin        TEXT,                   -- data_origin: the app that wrote the record (scale app, watch, ...)
  last_modified TEXT,
  data          TEXT NOT NULL,          -- the raw record as JSON
  ingested_at   TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS idx_records_type_start ON records (type, start_time);
CREATE INDEX IF NOT EXISTS idx_records_type_day ON records (type, day);

CREATE TABLE IF NOT EXISTS ingest_log (
  received_at TEXT NOT NULL,
  app_version TEXT,
  timezone    TEXT,
  types       TEXT,                     -- JSON {type: count}
  upserted    INTEGER NOT NULL,
  deleted     INTEGER NOT NULL
);
