// CS Collections — Import accounts from Google Sheet "Past Due" tab
// Read-only pull — does NOT write anything back to the sheet

import { NextResponse } from "next/server";
import { google } from "googleapis";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";

const SHEET_ID = "15iOhGuuWk7ckMN3McrlKCOwGBouCxaLWhCuJbVaLjY0";
const TAB_NAME = "Past Due";

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT env var not set");
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

// Normalize phone: strip non-digits, remove leading 1 if 11 digits
function normPhone(raw: string): string {
  const d = (raw || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "preview"; // "preview" or "import"

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Read ALL columns from the Past Due tab
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}`,
    });

    const rows = res.data.values;
    if (!rows || rows.length < 2) {
      return NextResponse.json({ ok: false, error: "Sheet is empty or has no data rows", rowCount: rows?.length || 0 });
    }

    const header = rows[0].map((h: string) => (h || "").toString().trim());

    // If preview mode, return headers + first 3 data rows for column mapping
    if (mode === "preview") {
      return NextResponse.json({
        ok: true,
        mode: "preview",
        headerCount: header.length,
        headers: header.map((h: string, i: number) => `${i}:${String.fromCharCode(65 + (i < 26 ? i : 25))}=${h}`),
        sampleRows: rows.slice(1, 4).map((r: string[]) => r.map((c: string, i: number) => `${i}:${c}`)),
        totalDataRows: rows.length - 1,
      });
    }

    // === IMPORT MODE ===
    // Find column positions from header row
    const colIdx: Record<string, number> = {};
    // findCol: fuzzy (includes) match
    const findCol = (patterns: string[]): number => {
      for (const p of patterns) {
        const idx = header.findIndex((h: string) => h.toLowerCase().includes(p.toLowerCase()));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    // findColExact: exact (equals) match — for short ambiguous names like "Date"
    const findColExact = (patterns: string[]): number => {
      for (const p of patterns) {
        const idx = header.findIndex((h: string) => h.toLowerCase() === p.toLowerCase());
        if (idx >= 0) return idx;
      }
      return -1;
    };

    colIdx.rep = findCol(["Rep", "Assigned"]);
    colIdx.accountNum = findCol(["Account Number", "Account #", "Acct"]);
    colIdx.insuredName = findCol(["Insured Name", "Customer Name", "Name", "Insured"]);
    colIdx.policyNum = findCol(["Policy Number", "Policy #", "Policy"]);
    colIdx.agent = findCol(["Agent", "Entity"]);
    colIdx.installments = findCol(["Installments", "Inst"]);
    colIdx.nextDue = findCol(["Next Due", "Due Date"]);
    colIdx.schedCxl = findCol(["Sched CXL Date", "Scheduled Cancel", "CXL Date", "Cancellation Date"]);
    colIdx.billHold = findCol(["Bill Hold"]);
    colIdx.billingMethod = findCol(["Billing Method", "Billing"]);
    colIdx.amountDue = findCol(["Amount Due", "Amt Due"]);
    colIdx.mainPhone = findCol(["Main Phone"]);
    colIdx.workPhone = findCol(["Work Phone", "Alt Phone", "Phone 2"]);
    colIdx.homePhone = findCol(["Home Phone"]);
    colIdx.email = findCol(["Customer Email", "Email"]);
    colIdx.state = findColExact(["State"]);
    colIdx.dispo1 = findCol(["Dispo 1", "Disposition 1"]);
    colIdx.dispo2 = findCol(["Dispo 2", "Disposition 2"]);
    colIdx.dispoDate = findColExact(["Date", "Dispo Date"]);
    colIdx.emailSent = findCol(["Email Sent"]);

    // Must have at minimum account number
    if (colIdx.accountNum < 0) {
      return NextResponse.json({
        ok: false,
        error: "Could not find Account Number column",
        header,
        colIdx,
      });
    }

    const today = todayLocal();
    const val = (row: string[], idx: number): string => (idx >= 0 && row[idx] ? row[idx].toString().trim() : "");

    // Parse a date string (M/D/YYYY or MM/DD/YYYY or YYYY-MM-DD)
    const parseDate = (s: string): string | null => {
      if (!s) return null;
      // Already ISO
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      // M/D/YYYY
      const parts = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (parts) return `${parts[3]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
      // M/D/YY
      const parts2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      if (parts2) return `20${parts2[3]}-${parts2[1].padStart(2, "0")}-${parts2[2].padStart(2, "0")}`;
      return null;
    };

    // Parse money string ($1,234.56 -> 1234.56)
    const parseMoney = (s: string): number => {
      if (!s) return 0;
      const n = parseFloat(s.replace(/[$,]/g, ""));
      return isNaN(n) ? 0 : n;
    };

    // Build rows for insert
    const insertRows: unknown[][] = [];
    const skipped: string[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const acctNum = val(row, colIdx.accountNum);
      if (!acctNum || !/^\d{4}-/.test(acctNum)) {
        if (acctNum) skipped.push(acctNum);
        continue;
      }

      const rep = val(row, colIdx.rep);
      const insuredName = val(row, colIdx.insuredName);
      const policyNum = val(row, colIdx.policyNum);
      const agentEntity = val(row, colIdx.agent);
      const installments = parseInt(val(row, colIdx.installments)) || 0;
      const nextDue = parseDate(val(row, colIdx.nextDue));
      const schedCxl = parseDate(val(row, colIdx.schedCxl));
      const billHold = val(row, colIdx.billHold);
      const billingMethod = val(row, colIdx.billingMethod);
      const amountDue = parseMoney(val(row, colIdx.amountDue));
      const mainPhone = val(row, colIdx.mainPhone);
      const workPhone = val(row, colIdx.workPhone);
      const homePhone = val(row, colIdx.homePhone);
      const customerEmail = val(row, colIdx.email);
      const state = val(row, colIdx.state);
      const dispo1 = val(row, colIdx.dispo1);
      const dispo2 = val(row, colIdx.dispo2);
      const dispoDate = parseDate(val(row, colIdx.dispoDate));
      const emailSentRaw = val(row, colIdx.emailSent).toLowerCase();
      const emailSent = emailSentRaw === "yes" || emailSentRaw === "true" || emailSentRaw === "y";

      // Determine if this is a carryover (has a carry-over disposition)
      const isCarryover = ["Follow Up", "Scheduled PDP", "Mailed Check", "Mailed C."].includes(dispo1);

      insertRows.push([
        today,           // scrub_date
        acctNum,         // account_number
        insuredName,     // insured_name
        policyNum,       // policy_number
        agentEntity,     // agent_entity
        installments,    // installments_made
        nextDue,         // next_due_date
        schedCxl,        // sched_cxl_date
        billHold,        // bill_hold
        billingMethod,   // billing_method
        amountDue,       // amount_due
        mainPhone,       // main_phone
        homePhone,       // home_phone
        workPhone,       // work_phone
        customerEmail,   // customer_email
        state,           // state
        rep,             // assigned_rep
        dispo1,          // dispo_1
        dispo2,          // dispo_2
        dispoDate,       // dispo_date
        emailSent,       // email_sent
        isCarryover,     // is_carryover
      ]);
    }

    if (insertRows.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid account rows found", skipped });
    }

    // Delete existing records for today (replace with fresh sheet data)
    await query("DELETE FROM cs_past_due_accounts WHERE scrub_date = $1", [today]);

    // Batch insert — build VALUES clause
    const batchSize = 50;
    let inserted = 0;
    for (let b = 0; b < insertRows.length; b += batchSize) {
      const batch = insertRows.slice(b, b + batchSize);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let pIdx = 1;

      for (const row of batch) {
        const ph: string[] = [];
        for (const v of row) {
          ph.push(`$${pIdx++}`);
          values.push(v);
        }
        placeholders.push(`(${ph.join(",")})`);
      }

      await query(
        `INSERT INTO cs_past_due_accounts
         (scrub_date, account_number, insured_name, policy_number, agent_entity,
          installments_made, next_due_date, sched_cxl_date, bill_hold, billing_method,
          amount_due, main_phone, home_phone, work_phone, customer_email, state,
          assigned_rep, dispo_1, dispo_2, dispo_date, email_sent, is_carryover)
         VALUES ${placeholders.join(",")}`,
        values
      );
      inserted += batch.length;
    }

    // Also create a synthetic upload record so the UI shows metadata
    await query(
      `INSERT INTO cs_scrub_uploads (scrub_date, filename, raw_row_count, filtered_row_count, carryover_count, final_row_count)
       VALUES ($1, $2, $3, $3, 0, $3)
       ON CONFLICT DO NOTHING`,
      [today, `Google Sheet Import (${new Date().toLocaleTimeString()})`, inserted]
    );

    // Build rep breakdown
    const repBreakdown: Record<string, number> = {};
    for (const row of insertRows) {
      const rep = row[16] as string;
      if (rep) repBreakdown[rep] = (repBreakdown[rep] || 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      mode: "import",
      imported: inserted,
      skipped: skipped.length,
      totalSheetRows: rows.length - 1,
      colMapping: colIdx,
      repBreakdown,
      date: today,
    });
  } catch (e) {
    console.error("Sheet import error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
