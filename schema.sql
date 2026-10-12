CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL,
  bus_no TEXT NOT NULL,
  ip TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station ON requests(station_id, expires_at);
