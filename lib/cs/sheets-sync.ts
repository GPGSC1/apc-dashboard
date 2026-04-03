// CS Collections — Google Sheets disposition sync
// Reads dispositions from the "Past Due" tab and syncs to cs_past_due_accounts

import { google } from "googleapis";
import { query } from "../db/connection";
import { todayLocal } from "../date-utils";

const SHEET_ID = "15iOhGuuWk7ckMN3McrlKCOwGBouCxaLWhCuJbVaLjY0";
const TAB_NAME = "Past Due";

// Column positions in the Google Sheet (0-indexed from the values array)
const COL = {
  ACCOUNT_NUM: 1,  // B
  DISPO_1: 14,     // O
  DISPO_2: 15,     // P
  DATE: 16,        // Q
  EMAIL_SENT: 17,  // R
};

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT env var not set");

  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export async function syncDisposFromSheet(): Promise<{
  synced: number;
  skipped: number;
  notFound: number;
  total: number;
}> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Read all rows from the Past Due tab (columns A through R)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:R`,
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) {
    return { synced: 0, skipped: 0, notFound: 0, total: 0 };
  }

  const today = todayLocal();

  // Get all current accounts for today from DB
  const dbResult = await query(
    "SELECT id, account_number, dispo_1, dispo_2, dispo_date, email_sent FROM cs_past_due_accounts WHERE scrub_date = $1",
    [today]
  );
  const dbMap = new Map<string, { id: number; dispo_1: string; dispo_2: string; dispo_date: string | null; email_sent: boolean }>();
  for (const row of dbResult.rows) {
    dbMap.set(row.account_number, {
      id: row.id,
      dispo_1: row.dispo_1 || "",
      dispo_2: row.dispo_2 || "",
      dispo_date: row.dispo_date || null,
      email_sent: row.email_sent || false,
    });
  }

  let synced = 0;
  let skipped = 0;
  let notFound = 0;

  // Skip header row (index 0)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const accountNum = (row[COL.ACCOUNT_NUM] || "").trim();
    if (!accountNum) continue;

    const sheetDispo1 = (row[COL.DISPO_1] || "").trim();
    const sheetDispo2 = (row[COL.DISPO_2] || "").trim();
    const sheetDate = (row[COL.DATE] || "").trim();
    const sheetEmailRaw = (row[COL.EMAIL_SENT] || "").trim().toLowerCase();
    const sheetEmailSent = sheetEmailRaw === "yes" || sheetEmailRaw === "true" || sheetEmailRaw === "y";

    // Skip rows with no dispositions entered
    if (!sheetDispo1 && !sheetDispo2 && !sheetDate && !sheetEmailRaw) {
      skipped++;
      continue;
    }

    const dbRow = dbMap.get(accountNum);
    if (!dbRow) {
      notFound++;
      continue;
    }

    // Check if anything changed
    const dbEmailSent = dbRow.email_sent || false;
    if (
      sheetDispo1 === dbRow.dispo_1 &&
      sheetDispo2 === dbRow.dispo_2 &&
      sheetEmailSent === dbEmailSent
    ) {
      skipped++;
      continue;
    }

    // Parse the date from the sheet (could be M/D/YYYY or empty)
    let parsedDate: string | null = null;
    if (sheetDate) {
      const parts = sheetDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (parts) {
        parsedDate = `${parts[3]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
      }
    }

    // Update DB with sheet values (sheet wins during transition period)
    await query(
      `UPDATE cs_past_due_accounts
       SET dispo_1 = $1, dispo_2 = $2, dispo_date = $3, email_sent = $4, updated_at = NOW()
       WHERE id = $5`,
      [sheetDispo1, sheetDispo2, parsedDate, sheetEmailSent, dbRow.id]
    );
    synced++;
  }

  return { synced, skipped, notFound, total: rows.length - 1 };
}
