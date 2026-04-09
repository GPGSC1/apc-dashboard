import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { query, getPool } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";
import { CARRYOVER_DISPOSITIONS } from "../../../../lib/cs/constants";
import {
  transformPBSData,
  filterPastDue,
  sortByPriority,
  roundRobinAssign,
  weightedAssign,
  dedup,
  mergeAndSort,
  buildRepBreakdown,
  CleanAccount,
  RepWeight,
} from "../../../../lib/cs/scrub";

export async function POST(request: Request) {
  try {
    // One-time migration: add phone columns if missing
    try {
      await query("ALTER TABLE cs_past_due_accounts ADD COLUMN IF NOT EXISTS home_phone VARCHAR(20)");
      await query("ALTER TABLE cs_past_due_accounts ADD COLUMN IF NOT EXISTS mobile_phone VARCHAR(20)");
    } catch { /* columns already exist */ }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const scheduleJson = formData.get("schedule") as string | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "No file uploaded" }, { status: 400 });
    }

    const today = todayLocal();

    // 1. Parse Excel file
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

    // 2. Transform PBS data to clean accounts
    const allAccounts = transformPBSData(rawData);
    if (allAccounts.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "No valid data rows found. Make sure the file is a PBS Pending Cancellation Report.",
      }, { status: 400 });
    }

    const rawRowCount = allAccounts.length;

    // 3. Filter past due
    const { pastDue, notYetDueCount } = filterPastDue(allAccounts, today);

    // 4. Sort by priority (0 installments first)
    const sorted = sortByPriority(pastDue);

    // 5. Get working reps
    let workingReps: string[] = [];

    if (scheduleJson) {
      // Use schedule from the request (rep names that are checked as working)
      try {
        workingReps = JSON.parse(scheduleJson);
      } catch {
        // Fall through to DB lookup
      }
    }

    if (workingReps.length === 0) {
      // Fall back to DB: get today's schedule, or all active reps if no schedule set
      const schedResult = await query(
        `SELECT r.name
         FROM cs_reps r
         LEFT JOIN cs_rep_schedule s ON s.rep_id = r.id AND s.work_date = $1
         WHERE r.is_active = true AND COALESCE(s.is_working, true) = true
         ORDER BY r.name`,
        [today]
      );
      workingReps = schedResult.rows.map((r: { name: string }) => r.name);
    }

    if (workingReps.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "No working reps found. Set at least one rep as working before running the scrub.",
      }, { status: 400 });
    }

    // 6. Assign accounts — use weighted distribution if percentages exist, else round-robin
    const schedRows = await query(
      `SELECT r.name,
              COALESCE(s.zero_pay_pct, 0) as zero_pay_pct,
              COALESCE(s.non_zero_pay_pct, 0) as non_zero_pay_pct
       FROM cs_reps r
       JOIN cs_rep_schedule s ON s.rep_id = r.id AND s.work_date = $1
       WHERE r.is_active = true AND s.is_working = true
       ORDER BY r.name`,
      [today]
    );

    const hasWeights = schedRows.rows.some(
      (r: { zero_pay_pct: string; non_zero_pay_pct: string }) =>
        parseFloat(r.zero_pay_pct) > 0 || parseFloat(r.non_zero_pay_pct) > 0
    );

    if (hasWeights && schedRows.rows.length > 0) {
      const weights: RepWeight[] = schedRows.rows.map((r: { name: string; zero_pay_pct: string; non_zero_pay_pct: string }) => ({
        name: r.name,
        zeroPayPct: parseFloat(r.zero_pay_pct) || 0,
        nonZeroPayPct: parseFloat(r.non_zero_pay_pct) || 0,
      }));
      weightedAssign(sorted, weights);
    } else {
      roundRobinAssign(sorted, workingReps);
    }

    // 7. Build fresh account set for carry-over validation
    const freshAccountSet = new Set(allAccounts.map((a) => a.account_number));

    // 8. Find carry-overs from previous scrub
    const prevScrubResult = await query(
      "SELECT MAX(scrub_date) as prev_date FROM cs_past_due_accounts WHERE scrub_date < $1",
      [today]
    );
    const prevDate = prevScrubResult.rows[0]?.prev_date;

    let carryOvers: CleanAccount[] = [];
    let carryOverStale = 0;
    let carryOverResolved = 0;

    if (prevDate) {
      // Get yesterday's accounts with carry-over dispositions
      const carryOverDisposPlaceholders = CARRYOVER_DISPOSITIONS.map((_, i) => `$${i + 2}`).join(",");
      const prevAccounts = await query(
        `SELECT * FROM cs_past_due_accounts
         WHERE scrub_date = $1
         AND LOWER(TRIM(dispo_1)) IN (${carryOverDisposPlaceholders})`,
        [prevDate, ...CARRYOVER_DISPOSITIONS.map((d) => d.toLowerCase())]
      );

      for (const row of prevAccounts.rows) {
        // Check if dispo_date has passed
        if (row.dispo_date) {
          const dispoDate = String(row.dispo_date).slice(0, 10);
          if (dispoDate < today) {
            carryOverStale++;
            continue;
          }
        }

        // Check if account is still on the PBS list
        if (!freshAccountSet.has(row.account_number)) {
          carryOverResolved++;
          continue;
        }

        // Keep this carry-over
        carryOvers.push({
          account_number: row.account_number,
          insured_name: row.insured_name || "",
          policy_number: row.policy_number || "",
          agent_entity: row.agent_entity || "",
          installments_made: row.installments_made || 0,
          next_due_date: row.next_due_date ? String(row.next_due_date).slice(0, 10) : null,
          sched_cxl_date: row.sched_cxl_date ? String(row.sched_cxl_date).slice(0, 10) : null,
          bill_hold: row.bill_hold || "",
          billing_method: row.billing_method || "",
          amount_due: parseFloat(row.amount_due) || 0,
          main_phone: row.main_phone || "",
          home_phone: row.home_phone || "",
          mobile_phone: row.mobile_phone || "",
          work_phone: row.work_phone || "",
          customer_email: row.customer_email || "",
          state: row.state || "",
          assigned_rep: row.assigned_rep || "",
          dispo_1: row.dispo_1 || "",
          dispo_2: row.dispo_2 || "",
          dispo_date: row.dispo_date ? String(row.dispo_date).slice(0, 10) : null,
          email_sent: row.email_sent || false,
          is_carryover: true,
        });
      }
    }

    // 9. Dedup: remove fresh accounts that are carry-overs
    const carryoverAccountNums = new Set(carryOvers.map((c) => c.account_number));
    const { fresh: freshDeDuped, dupeCount } = dedup(sorted, carryoverAccountNums);

    // 10. Merge and sort
    const merged = mergeAndSort(carryOvers, freshDeDuped);

    // 11. Execute in transaction: backup + delete + insert
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      // Backup current day's records (if re-running same day)
      if (prevDate) {
        await client.query(
          `INSERT INTO cs_scrub_backups (backup_date, original_scrub_date, account_number, insured_name, policy_number, assigned_rep, dispo_1, dispo_2, dispo_date, amount_due)
           SELECT $1, scrub_date, account_number, insured_name, policy_number, assigned_rep, dispo_1, dispo_2, dispo_date, amount_due
           FROM cs_past_due_accounts
           WHERE scrub_date = $2`,
          [today, prevDate]
        );
      }

      // Delete today's existing records (in case of re-upload)
      await client.query("DELETE FROM cs_past_due_accounts WHERE scrub_date = $1", [today]);

      // Insert merged list
      for (const acct of merged) {
        await client.query(
          `INSERT INTO cs_past_due_accounts
           (scrub_date, account_number, insured_name, policy_number, agent_entity,
            installments_made, next_due_date, sched_cxl_date, bill_hold, billing_method,
            amount_due, main_phone, home_phone, mobile_phone, work_phone, customer_email, state,
            assigned_rep, dispo_1, dispo_2, dispo_date, email_sent, is_carryover)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           ON CONFLICT (scrub_date, account_number) DO UPDATE SET
             assigned_rep = EXCLUDED.assigned_rep,
             dispo_1 = EXCLUDED.dispo_1,
             dispo_2 = EXCLUDED.dispo_2,
             dispo_date = EXCLUDED.dispo_date,
             is_carryover = EXCLUDED.is_carryover,
             updated_at = NOW()`,
          [
            today, acct.account_number, acct.insured_name, acct.policy_number, acct.agent_entity,
            acct.installments_made, acct.next_due_date, acct.sched_cxl_date, acct.bill_hold, acct.billing_method,
            acct.amount_due, acct.main_phone, acct.home_phone, acct.mobile_phone, acct.work_phone, acct.customer_email, acct.state,
            acct.assigned_rep, acct.dispo_1, acct.dispo_2, acct.dispo_date, acct.email_sent, acct.is_carryover,
          ]
        );
      }

      // Insert upload metadata
      await client.query(
        `INSERT INTO cs_scrub_uploads (scrub_date, filename, raw_row_count, filtered_row_count, carryover_count, final_row_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [today, file.name, rawRowCount, pastDue.length, carryOvers.length, merged.length]
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // 12. Build summary
    const repBreakdown = buildRepBreakdown(merged);

    return NextResponse.json({
      ok: true,
      summary: {
        scrubDate: today,
        filename: file.name,
        rawRowCount,
        notYetDueCount,
        pastDueCount: pastDue.length,
        carryOverKept: carryOvers.length,
        carryOverStale,
        carryOverResolved,
        dupeCount,
        finalCount: merged.length,
        workingReps,
        repBreakdown,
      },
    });
  } catch (e) {
    console.error("CS Upload error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
