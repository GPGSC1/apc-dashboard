// CS Collections — Daily Snapshot
// Locks in daily metrics before the next morning's pull overwrites today's list.
// Runs nightly at 11:55 PM CT. Each snapshot row is a historical record that can
// be summed across any date range.

import { query } from "../db/connection";

export async function ensureSnapshotTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS cs_daily_snapshot (
      snapshot_date DATE PRIMARY KEY,
      total_accounts INTEGER DEFAULT 0,
      zero_pay_accounts INTEGER DEFAULT 0,
      non_zero_accounts INTEGER DEFAULT 0,
      accounts_called INTEGER DEFAULT 0,
      collections_count INTEGER DEFAULT 0,
      zero_pay_collections INTEGER DEFAULT 0,
      non_zero_collections INTEGER DEFAULT 0,
      amt_collected NUMERIC(12,2) DEFAULT 0,
      calls_dialed INTEGER DEFAULT 0,
      snapshot_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/** Normalize a phone to 10 digits (strips non-digits, drops leading 1 if 11 digits) */
function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

export interface SnapshotRow {
  snapshot_date: string;
  total_accounts: number;
  zero_pay_accounts: number;
  non_zero_accounts: number;
  accounts_called: number;
  collections_count: number;
  zero_pay_collections: number;
  non_zero_collections: number;
  amt_collected: number;
  calls_dialed: number;
}

/**
 * Compute the snapshot for a given date from the current state of
 * cs_past_due_accounts and cs_outbound_calls.
 */
export async function computeSnapshot(dateStr: string): Promise<SnapshotRow> {
  // List-level counts + collections from cs_past_due_accounts
  const accRes = await query(
    `SELECT
      COUNT(*) AS total_accounts,
      COUNT(*) FILTER (WHERE installments_made = 0) AS zero_pay_accounts,
      COUNT(*) FILTER (WHERE installments_made > 0) AS non_zero_accounts,
      COUNT(*) FILTER (WHERE dispo_1 = 'Collected') AS collections_count,
      COUNT(*) FILTER (WHERE dispo_1 = 'Collected' AND installments_made = 0) AS zero_pay_collections,
      COUNT(*) FILTER (WHERE dispo_1 = 'Collected' AND installments_made > 0) AS non_zero_collections,
      COALESCE(SUM(amount_due) FILTER (WHERE dispo_1 = 'Collected'), 0) AS amt_collected
    FROM cs_past_due_accounts
    WHERE scrub_date = $1`,
    [dateStr]
  );
  const acc = accRes.rows[0] || {};

  // Accounts called — distinct accounts on today's list where at least one
  // phone (main_phone or work_phone) was dialed at any time on dateStr
  const calledRes = await query(
    `SELECT COUNT(DISTINCT a.id) AS accounts_called
     FROM cs_past_due_accounts a
     WHERE a.scrub_date = $1
       AND EXISTS (
         SELECT 1 FROM cs_outbound_calls c
         WHERE c.call_time::date = $1
           AND (
             c.phone = REGEXP_REPLACE(COALESCE(a.main_phone, ''), '\\D', '', 'g')
             OR c.phone = REGEXP_REPLACE(COALESCE(a.work_phone, ''), '\\D', '', 'g')
             OR c.phone = RIGHT(REGEXP_REPLACE(COALESCE(a.main_phone, ''), '\\D', '', 'g'), 10)
             OR c.phone = RIGHT(REGEXP_REPLACE(COALESCE(a.work_phone, ''), '\\D', '', 'g'), 10)
           )
       )`,
    [dateStr]
  );
  const accountsCalled = parseInt(calledRes.rows[0]?.accounts_called || "0", 10);

  // Total outbound calls dialed on the day (from 3CX log)
  const callsRes = await query(
    "SELECT COUNT(*) AS calls_dialed FROM cs_outbound_calls WHERE call_time::date = $1",
    [dateStr]
  );
  const callsDialed = parseInt(callsRes.rows[0]?.calls_dialed || "0", 10);

  return {
    snapshot_date: dateStr,
    total_accounts: parseInt(acc.total_accounts || "0", 10),
    zero_pay_accounts: parseInt(acc.zero_pay_accounts || "0", 10),
    non_zero_accounts: parseInt(acc.non_zero_accounts || "0", 10),
    accounts_called: accountsCalled,
    collections_count: parseInt(acc.collections_count || "0", 10),
    zero_pay_collections: parseInt(acc.zero_pay_collections || "0", 10),
    non_zero_collections: parseInt(acc.non_zero_collections || "0", 10),
    amt_collected: parseFloat(acc.amt_collected || "0"),
    calls_dialed: callsDialed,
  };
}

/** Persist a snapshot row (upsert by snapshot_date) */
export async function saveSnapshot(s: SnapshotRow): Promise<void> {
  await query(
    `INSERT INTO cs_daily_snapshot (
        snapshot_date, total_accounts, zero_pay_accounts, non_zero_accounts,
        accounts_called, collections_count, zero_pay_collections, non_zero_collections,
        amt_collected, calls_dialed, snapshot_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
      ON CONFLICT (snapshot_date) DO UPDATE SET
        total_accounts = EXCLUDED.total_accounts,
        zero_pay_accounts = EXCLUDED.zero_pay_accounts,
        non_zero_accounts = EXCLUDED.non_zero_accounts,
        accounts_called = EXCLUDED.accounts_called,
        collections_count = EXCLUDED.collections_count,
        zero_pay_collections = EXCLUDED.zero_pay_collections,
        non_zero_collections = EXCLUDED.non_zero_collections,
        amt_collected = EXCLUDED.amt_collected,
        calls_dialed = EXCLUDED.calls_dialed,
        snapshot_at = NOW()`,
    [
      s.snapshot_date,
      s.total_accounts,
      s.zero_pay_accounts,
      s.non_zero_accounts,
      s.accounts_called,
      s.collections_count,
      s.zero_pay_collections,
      s.non_zero_collections,
      s.amt_collected,
      s.calls_dialed,
    ]
  );
}

export async function takeSnapshot(dateStr: string): Promise<SnapshotRow> {
  await ensureSnapshotTable();
  const snap = await computeSnapshot(dateStr);
  await saveSnapshot(snap);
  return snap;
}

// Silence unused-import linter for normalizePhone (kept for future use)
void normalizePhone;
