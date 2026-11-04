import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, "zklane.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS channels(
  name TEXT PRIMARY KEY,            -- customer-local channel handle
  channel_id TEXT,                  -- real zkChannels channel id (hex)
  amount_zats INTEGER, cust_units INTEGER,
  status TEXT,                      -- awaiting_funds|funding_sent|funded|open|closing|closed|cheat_detected|error
  open_txid TEXT, open_height INTEGER, close_txid TEXT, refund_zats INTEGER,
  final_cust_units INTEGER, cheat_evidence TEXT, error TEXT,
  created_at INTEGER, updated_at INTEGER);
-- Merchant-side payment log. Deliberately NO payer / channel column: the merchant
-- verifies a ZK proof and learns only that *some* valid channel paid this amount.
CREATE TABLE IF NOT EXISTS payments(
  n INTEGER PRIMARY KEY AUTOINCREMENT, amount_units INTEGER, item TEXT,
  received_at INTEGER, latency_ms INTEGER);
CREATE TABLE IF NOT EXISTS watcher_state(k TEXT PRIMARY KEY, v TEXT);
`);

export interface ChannelRow {
  name: string; channel_id: string | null; amount_zats: number; cust_units: number; status: string;
  open_txid: string | null; open_height: number | null; close_txid: string | null; refund_zats: number | null;
  final_cust_units: number | null; cheat_evidence: string | null; error: string | null;
  created_at: number; updated_at: number;
}

export const q = {
  insertChannel: db.prepare(`INSERT INTO channels(name, channel_id, amount_zats, cust_units, status, created_at, updated_at)
    VALUES(@name, @channel_id, @amount_zats, @cust_units, @status, @now, @now)`),
  get: db.prepare<[string], ChannelRow>(`SELECT * FROM channels WHERE name = ?`),
  byChannelId: db.prepare<[string], ChannelRow>(`SELECT * FROM channels WHERE channel_id = ?`),
  list: db.prepare<[], ChannelRow>(`SELECT * FROM channels ORDER BY created_at DESC`),
  byStatus: db.prepare<[string], ChannelRow>(`SELECT * FROM channels WHERE status = ?`),
  insertPayment: db.prepare(`INSERT INTO payments(amount_units, item, received_at, latency_ms) VALUES(?, ?, ?, ?)`),
  payments: db.prepare(`SELECT * FROM payments ORDER BY n DESC LIMIT 200`),
  stats: db.prepare(`SELECT COUNT(*) AS n, COALESCE(AVG(latency_ms),0) AS avg_ms, COALESCE(SUM(amount_units),0) AS units FROM payments`),
  getKv: db.prepare<[string], { v: string }>(`SELECT v FROM watcher_state WHERE k = ?`),
  setKv: db.prepare(`INSERT INTO watcher_state(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`),
};

export function updateChannel(name: string, fields: Partial<ChannelRow>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE channels SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @__now WHERE name = @__name`)
    .run({ ...fields, __now: Date.now(), __name: name });
}
