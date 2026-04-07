// CS Historical Snapshot Architecture
// ────────────────────────────────────
// Three append-only tables that preserve the daily PBS list, raw 3CX call activity,
// and end-of-day Google Sheet dispositions for permanent historical reference.
//
//   cs_account_daily   — every PBS row, every morning, frozen forever
//   cs_raw_calls       — raw 3CX call detail (inbound + outbound), no filtering
//   cs_dispo_history   — 10pm CT freeze of the Google Sheet "Past Due" tab
//
// Nothing here ever updates after the day closes. Scrubbing/dedup happens at
// query time in the dashboard, not at insert time.

import { query } from "../db/connection";

export async function ensureHistoricalTables() {
  // ── 1. Morning PBS snapshot — append-only, dedup within a single pull ─────
  await query(`
    CREATE TABLE IF NOT EXISTS cs_account_daily (
      scrub_date          DATE NOT NULL,
      account_number      TEXT NOT NULL,
      insured_name        TEXT,
      policy_number       TEXT,
      agent_entity        TEXT,
      installments_made   INTEGER,
      next_due_date       DATE,
      sched_cxl_date      DATE,
      bill_hold           TEXT,
      billing_method      TEXT,
      amount_due          NUMERIC(12,2),
      main_phone          TEXT,
      home_phone          TEXT,
      work_phone          TEXT,
      customer_email      TEXT,
      state               TEXT,
      assigned_rep        TEXT,
      raw_row             JSONB,
      pulled_at           TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (scrub_date, account_number)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_account_daily_account ON cs_account_daily(account_number)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_account_daily_main_phone ON cs_account_daily(main_phone)`);

  // ── 2. Raw 3CX call detail — append-only, no filtering ───────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS cs_raw_calls (
      call_id      TEXT PRIMARY KEY,
      started_at   TIMESTAMPTZ,
      call_date    DATE,
      direction    TEXT,
      phone        TEXT,
      first_ext    TEXT,
      agent_name   TEXT,
      destination  TEXT,
      queue_name   TEXT,
      status       TEXT,
      raw_row      JSONB,
      pulled_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_raw_calls_phone_date ON cs_raw_calls(phone, call_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_raw_calls_call_date ON cs_raw_calls(call_date)`);

  // ── 3. Google Sheet "Past Due" tab freeze — 10pm CT lock ──────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS cs_dispo_history (
      scrub_date         DATE NOT NULL,
      account_number     TEXT NOT NULL,
      rep                TEXT,
      customer_name      TEXT,
      policy_number      TEXT,
      installments_made  TEXT,
      next_due_date      TEXT,
      sched_cxl_date     TEXT,
      bill_hold          TEXT,
      billing_method     TEXT,
      amount_due         TEXT,
      main_phone         TEXT,
      work_phone         TEXT,
      customer_email     TEXT,
      state              TEXT,
      dispo_1            TEXT,
      dispo_2            TEXT,
      dispo_date         TEXT,
      email_sent         TEXT,
      raw_row            JSONB,
      frozen             BOOLEAN DEFAULT false,
      captured_at        TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (scrub_date, account_number)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_dispo_history_account ON cs_dispo_history(account_number)`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const CT_TZ = "America/Chicago";
export function todayCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function norm10(p: string | null | undefined): string {
  if (!p) return "";
  const d = String(p).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}
