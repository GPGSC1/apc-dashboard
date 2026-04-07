// CS Dispo Freeze — pulls the "Past Due" tab of the reps' Google Sheet
// and locks it into cs_dispo_history. Append-only, keyed (scrub_date, account_number).
//
// Sheet: 15iOhGuuWk7ckMN3McrlKCOwGBouCxaLWhCuJbVaLjY0
// Tab:   "Past Due"
// Columns (A-R, 18 populated):
//   A REP | B Account Number | C Customer Name | D Policy Number
//   E Installments Made | F Next Due Date | G Sched CXL Date | H Bill Hold
//   I Billing Method | J Amount Due | K Main Phone | L Work Phone
//   M Customer Email | N State | O Dispo 1 | P Dispo 2 | Q Date | R Email Sent

import { google } from "googleapis";
import { getPool } from "../db/connection";
import { ensureHistoricalTables, todayCT } from "./historical";

const PAST_DUE_SHEET_ID = "15iOhGuuWk7ckMN3McrlKCOwGBouCxaLWhCuJbVaLjY0";
const PAST_DUE_TAB = "Past Due";

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT env var not set");
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export async function freezeDispoHistory(opts: { scrubDate?: string; freeze?: boolean } = {}) {
  const scrubDate = opts.scrubDate || todayCT();
  const freeze = opts.freeze !== false; // default true

  await ensureHistoricalTables();

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PAST_DUE_SHEET_ID,
    range: `'${PAST_DUE_TAB}'!A2:R`,
  });

  const rows = res.data.values || [];
  let inserted = 0;
  let updated = 0;
  const seen = new Set<string>();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const accountNumber = (row[1] || "").toString().trim();
      if (!accountNumber) continue;
      if (seen.has(accountNumber)) continue;
      seen.add(accountNumber);

      const raw: Record<string, string> = {
        REP: row[0] || "",
        "Account Number": row[1] || "",
        "Customer Name": row[2] || "",
        "Policy Number": row[3] || "",
        "Installments Made": row[4] || "",
        "Next Due Date": row[5] || "",
        "Sched CXL Date": row[6] || "",
        "Bill Hold": row[7] || "",
        "Billing Method": row[8] || "",
        "Amount Due": row[9] || "",
        "Main Phone": row[10] || "",
        "Work Phone": row[11] || "",
        "Customer Email": row[12] || "",
        State: row[13] || "",
        "Dispo 1": row[14] || "",
        "Dispo 2": row[15] || "",
        Date: row[16] || "",
        "Email Sent": row[17] || "",
      };

      const result = await client.query(
        `INSERT INTO cs_dispo_history
         (scrub_date, account_number, rep, customer_name, policy_number,
          installments_made, next_due_date, sched_cxl_date, bill_hold,
          billing_method, amount_due, main_phone, work_phone, customer_email,
          state, dispo_1, dispo_2, dispo_date, email_sent, raw_row, frozen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (scrub_date, account_number) DO UPDATE SET
           rep = EXCLUDED.rep,
           dispo_1 = EXCLUDED.dispo_1,
           dispo_2 = EXCLUDED.dispo_2,
           dispo_date = EXCLUDED.dispo_date,
           email_sent = EXCLUDED.email_sent,
           raw_row = EXCLUDED.raw_row,
           frozen = CASE WHEN cs_dispo_history.frozen THEN cs_dispo_history.frozen ELSE EXCLUDED.frozen END,
           captured_at = NOW()
         RETURNING (xmax = 0) AS was_inserted`,
        [
          scrubDate, accountNumber, raw.REP, raw["Customer Name"], raw["Policy Number"],
          raw["Installments Made"], raw["Next Due Date"], raw["Sched CXL Date"], raw["Bill Hold"],
          raw["Billing Method"], raw["Amount Due"], raw["Main Phone"], raw["Work Phone"],
          raw["Customer Email"], raw.State, raw["Dispo 1"], raw["Dispo 2"], raw.Date,
          raw["Email Sent"], JSON.stringify(raw), freeze,
        ]
      );
      if (result.rows[0]?.was_inserted) inserted++;
      else updated++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return { ok: true, scrubDate, totalRows: rows.length, inserted, updated, frozen: freeze };
}
