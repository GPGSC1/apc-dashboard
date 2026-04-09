// CS Collections — Daily Stats sync from Google Sheets
// Each month has its own spreadsheet with tabs 1-31 (one per day).
// Each day tab has a "DAILY STATS" section with per-rep metrics.
// Columns: Rep | Collection | 0Pay | PIF (2 pmts+) | Chargeback | Amt Collected | Sold | DP Amount Collected | Total

import { google } from "googleapis";
import { query } from "../db/connection";

// ─── Spreadsheet IDs by month (YYYY-MM -> Google Sheet ID) ───
// Add new months here as Jeremy creates new workbooks
export const STATS_SHEETS: Record<string, string> = {
  "2026-01": "1K1Gy3LiTlfs6tsD3xA8UnG_KRvSSlH4grIGA37KyYYg",
  "2026-02": "1u7U_4MBprTXzzVynYjVBV-35NGaEs6wzKdtUvHMtB64",
  "2026-03": "1geV7lmU0IYQ-qAt7rst9ajHpldkbPiofmZigoGPKZ2Y",
  "2026-04": "1i2Xkkh3C0S06VktRAr_VuHe8J2FjvECbrsWNDbENEWQ",
};

// Column layout in each day tab (0-indexed from values array)
const COL = {
  REP: 0,          // A
  COLLECTION: 1,   // B
  ZERO_PAY: 2,     // C
  PIF: 3,          // D
  CHARGEBACK: 4,   // E
  AMT_COLLECTED: 5,// F
  SOLD: 6,         // G
  DP_AMT: 7,       // H
  TOTAL: 8,        // I
};

// Known rep names to filter signal from noise rows
const KNOWN_REPS = new Set([
  "Ashton Ray", "Danielle Firle", "David Colin", "Josh Aguirre",
  "Katelyn Miller", "Mallory Stevens", "Mark Colin", "Rachel Brown",
  "Steven Lachino", "Adrian Baptista", "Angello Acevedo", "Tomas Ospina",
  "Joe Chavez",
]);

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT env var not set");
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

function parseNum(val: string | undefined): number {
  if (!val) return 0;
  // Strip $ , and whitespace
  const cleaned = val.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function parseInt0(val: string | undefined): number {
  if (!val) return 0;
  const n = parseInt(val.replace(/[$,\s]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

/** Ensure cs_daily_stats table exists */
export async function ensureStatsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS cs_daily_stats (
      id SERIAL PRIMARY KEY,
      stat_date DATE NOT NULL,
      rep_name VARCHAR(100) NOT NULL,
      collections INTEGER DEFAULT 0,
      zero_pays INTEGER DEFAULT 0,
      pif INTEGER DEFAULT 0,
      chargebacks INTEGER DEFAULT 0,
      amt_collected NUMERIC(12,2) DEFAULT 0,
      sold INTEGER DEFAULT 0,
      dp_amt_collected NUMERIC(12,2) DEFAULT 0,
      total INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(stat_date, rep_name)
    )
  `);
}

/** Check if a row looks like a rep data row */
function isRepRow(row: string[]): boolean {
  const name = (row[COL.REP] || "").trim();
  if (!name) return false;
  // Check known rep names
  if (KNOWN_REPS.has(name)) return true;
  // Heuristic: has at least a first and last name, and collection column is numeric
  const parts = name.split(/\s+/);
  if (parts.length < 2) return false;
  const collVal = (row[COL.COLLECTION] || "").trim();
  return /^\d+$/.test(collVal) || collVal === "" || collVal === "0";
}

/** Sync a single month's spreadsheet into cs_daily_stats */
export async function syncMonth(yearMonth: string, sheetId: string): Promise<{
  synced: number;
  days: number;
}> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const [year, monthStr] = yearMonth.split("-");
  const month = parseInt(monthStr, 10);
  const daysInMonth = new Date(parseInt(year, 10), month, 0).getDate();

  let synced = 0;
  let days = 0;

  // Read each day tab (1 through daysInMonth)
  for (let day = 1; day <= daysInMonth; day++) {
    const tabName = String(day);
    const dateStr = `${year}-${monthStr}-${String(day).padStart(2, "0")}`;

    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:I`,
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) continue;

      // Find the "DAILY STATS" section (look for a row containing "DAILY STATS" or "Rep" header)
      let startIdx = -1;
      for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const firstCell = (rows[i][0] || "").toString().toUpperCase().trim();
        const secondCell = (rows[i][1] || "").toString().toUpperCase().trim();
        if (firstCell.includes("DAILY STATS") || firstCell === "REP" ||
            (firstCell === "REP" && secondCell.includes("COLLECTION"))) {
          startIdx = i;
          break;
        }
      }

      // If we found "DAILY STATS" header, the actual header row is the next row
      if (startIdx >= 0) {
        const headerCell = (rows[startIdx][0] || "").toString().toUpperCase().trim();
        if (headerCell.includes("DAILY STATS")) {
          startIdx++; // skip to the Rep header row
        }
        startIdx++; // skip header row to first data row
      } else {
        // Fallback: start from row 2 (skip whatever header is in row 0/1)
        startIdx = 2;
      }

      // Read rep rows until we hit "Total" row or empty or MTD section
      for (let i = startIdx; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const firstCell = (row[COL.REP] || "").toString().trim();
        if (!firstCell) continue;

        // Stop at Total row or MTD section
        if (firstCell.toUpperCase() === "TOTAL" || firstCell.toUpperCase().includes("MTD")) break;

        // Skip non-rep rows (headers, 3CX config, etc.)
        if (!isRepRow(row)) continue;

        const repName = firstCell;
        const collections = parseInt0(row[COL.COLLECTION]?.toString());
        const zeroPays = parseInt0(row[COL.ZERO_PAY]?.toString());
        const pif = parseInt0(row[COL.PIF]?.toString());
        const chargebacks = parseInt0(row[COL.CHARGEBACK]?.toString());
        const amtCollected = parseNum(row[COL.AMT_COLLECTED]?.toString());
        const sold = parseInt0(row[COL.SOLD]?.toString());
        const dpAmt = parseNum(row[COL.DP_AMT]?.toString());
        const total = parseInt0(row[COL.TOTAL]?.toString());

        await query(
          `INSERT INTO cs_daily_stats (stat_date, rep_name, collections, zero_pays, pif, chargebacks, amt_collected, sold, dp_amt_collected, total, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
           ON CONFLICT (stat_date, rep_name) DO UPDATE SET
             collections = EXCLUDED.collections,
             zero_pays = EXCLUDED.zero_pays,
             pif = EXCLUDED.pif,
             chargebacks = EXCLUDED.chargebacks,
             amt_collected = EXCLUDED.amt_collected,
             sold = EXCLUDED.sold,
             dp_amt_collected = EXCLUDED.dp_amt_collected,
             total = EXCLUDED.total,
             updated_at = NOW()`,
          [dateStr, repName, collections, zeroPays, pif, chargebacks, amtCollected, sold, dpAmt, total]
        );
        synced++;
      }
      days++;
    } catch (e: unknown) {
      // Tab might not exist (e.g., day 31 in a 30-day month)
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Unable to parse range") || msg.includes("not found")) {
        continue; // expected — tab doesn't exist
      }
      console.error(`[stats-sync] Error reading tab ${tabName} from ${yearMonth}:`, e);
    }
  }

  return { synced, days };
}

/** Sync all configured months */
export async function syncAllStats(): Promise<{
  months: number;
  totalSynced: number;
  totalDays: number;
  errors: string[];
}> {
  await ensureStatsTable();

  let totalSynced = 0;
  let totalDays = 0;
  let months = 0;
  const errors: string[] = [];

  for (const [yearMonth, sheetId] of Object.entries(STATS_SHEETS)) {
    try {
      const result = await syncMonth(yearMonth, sheetId);
      totalSynced += result.synced;
      totalDays += result.days;
      months++;
      console.log(`[stats-sync] ${yearMonth}: ${result.synced} rows, ${result.days} days`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${yearMonth}: ${msg}`);
      console.error(`[stats-sync] Error syncing ${yearMonth}:`, e);
    }
  }

  return { months, totalSynced, totalDays, errors };
}

/** Sync only the current month (for nightly cron) */
export async function syncCurrentMonth(): Promise<{
  synced: number;
  days: number;
  month: string;
}> {
  await ensureStatsTable();

  // Get current month in CT
  const now = new Date();
  const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const yearMonth = `${ct.getFullYear()}-${String(ct.getMonth() + 1).padStart(2, "0")}`;

  const sheetId = STATS_SHEETS[yearMonth];
  if (!sheetId) {
    console.log(`[stats-sync] No spreadsheet configured for ${yearMonth}`);
    return { synced: 0, days: 0, month: yearMonth };
  }

  const result = await syncMonth(yearMonth, sheetId);
  return { ...result, month: yearMonth };
}
