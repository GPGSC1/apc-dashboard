// CS Daily Pull — Cron endpoint for automated PBS pull + distribution
//
// GATED: Only runs when CS_PULL_ENABLED=true in env vars.
// Until then, this is a no-op that returns { ok: true, status: "disabled" }.
//
// Flow:
//   8:15 AM CT cron → check if today's rep schedule is saved
//     → YES: pull PBS, scrub, distribute using saved percentages
//     → NO:  send Jeremy a text reminder, mark pull as "waiting_schedule"
//
// When Jeremy saves the schedule (via /api/cs/reps POST set_schedule),
//   if pull status is "waiting_schedule" → auto-trigger the pull
//
// Manual trigger: POST /api/cs/daily-pull { action: "trigger" }

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { sendSMS } from "../../../../lib/cs/twilio";

const CT_TZ = "America/Chicago";

function todayCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// ── One-time migration ──
async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS cs_daily_pull_status (
      pull_date DATE PRIMARY KEY,
      schedule_saved BOOLEAN DEFAULT false,
      schedule_saved_at TIMESTAMPTZ,
      pull_status VARCHAR(30) DEFAULT 'pending',
      pull_triggered_at TIMESTAMPTZ,
      pull_completed_at TIMESTAMPTZ,
      pull_error TEXT,
      reminder_sent BOOLEAN DEFAULT false,
      reminder_sent_at TIMESTAMPTZ,
      accounts_distributed INTEGER DEFAULT 0
    )
  `);
}

// ── Get or create today's status row ──
async function getOrCreateStatus(date: string) {
  await ensureTable();
  const existing = await query("SELECT * FROM cs_daily_pull_status WHERE pull_date = $1", [date]);
  if (existing.rows.length > 0) return existing.rows[0];

  await query(
    "INSERT INTO cs_daily_pull_status (pull_date) VALUES ($1) ON CONFLICT DO NOTHING",
    [date]
  );
  const result = await query("SELECT * FROM cs_daily_pull_status WHERE pull_date = $1", [date]);
  return result.rows[0];
}

// ── Check if schedule was saved for today ──
async function isScheduleSaved(date: string): Promise<boolean> {
  const result = await query(
    "SELECT COUNT(*) as cnt FROM cs_rep_schedule WHERE work_date = $1",
    [date]
  );
  return parseInt(result.rows[0]?.cnt) > 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET — Cron handler (8:15 AM CT)
// ═══════════════════════════════════════════════════════════════════════════════
export async function GET() {
  const enabled = process.env.CS_PULL_ENABLED === "true";

  if (!enabled) {
    return NextResponse.json({ ok: true, status: "disabled", message: "CS_PULL_ENABLED is not set to true" });
  }

  try {
    const today = todayCT();
    const status = await getOrCreateStatus(today);

    // If pull already completed today, skip
    if (status.pull_status === "complete") {
      return NextResponse.json({ ok: true, status: "already_complete", date: today });
    }

    const scheduleSaved = await isScheduleSaved(today);

    if (scheduleSaved) {
      // Schedule is saved — mark it and trigger the pull
      await query(
        `UPDATE cs_daily_pull_status
         SET schedule_saved = true, schedule_saved_at = NOW(), pull_status = 'pulling', pull_triggered_at = NOW()
         WHERE pull_date = $1`,
        [today]
      );

      // Trigger the actual PBS pull + scrub
      const pullResult = await executePull(today);

      await query(
        `UPDATE cs_daily_pull_status
         SET pull_status = $2, pull_completed_at = NOW(),
             pull_error = $3, accounts_distributed = $4
         WHERE pull_date = $1`,
        [today, pullResult.ok ? "complete" : "error", pullResult.error || null, pullResult.accountCount || 0]
      );

      return NextResponse.json({
        ok: true,
        status: pullResult.ok ? "complete" : "error",
        date: today,
        accountCount: pullResult.accountCount,
        error: pullResult.error,
      });
    } else {
      // Schedule NOT saved — send reminder, mark waiting
      await query(
        `UPDATE cs_daily_pull_status
         SET pull_status = 'waiting_schedule'
         WHERE pull_date = $1`,
        [today]
      );

      // Send SMS reminder if not already sent
      if (!status.reminder_sent) {
        const jeremyPhone = process.env.CS_MANAGER_PHONE;
        if (jeremyPhone) {
          const dashUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/cs`
            : "the Collections dashboard";
          await sendSMS(
            jeremyPhone,
            `Collections: Today's rep schedule hasn't been set yet. The PBS pull is waiting on you.\n\nSet it here: ${dashUrl}\n\nThe pull will run automatically once you save the schedule.`
          );
          await query(
            `UPDATE cs_daily_pull_status SET reminder_sent = true, reminder_sent_at = NOW() WHERE pull_date = $1`,
            [today]
          );
        }
      }

      return NextResponse.json({
        ok: true,
        status: "waiting_schedule",
        date: today,
        reminderSent: true,
      });
    }
  } catch (e) {
    console.error("[daily-pull] Cron error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST — Manual trigger / schedule-saved trigger
// ═══════════════════════════════════════════════════════════════════════════════
export async function POST(request: Request) {
  const enabled = process.env.CS_PULL_ENABLED === "true";

  if (!enabled) {
    return NextResponse.json({ ok: true, status: "disabled", message: "CS_PULL_ENABLED is not set to true" });
  }

  try {
    const body = await request.json();
    const { action } = body;
    const today = todayCT();

    if (action === "trigger" || action === "schedule_saved") {
      const status = await getOrCreateStatus(today);

      // If already complete or currently pulling, skip
      if (status.pull_status === "complete") {
        return NextResponse.json({ ok: true, status: "already_complete" });
      }
      if (status.pull_status === "pulling") {
        return NextResponse.json({ ok: true, status: "already_pulling" });
      }

      // Mark schedule as saved
      await query(
        `UPDATE cs_daily_pull_status
         SET schedule_saved = true, schedule_saved_at = NOW(), pull_status = 'pulling', pull_triggered_at = NOW()
         WHERE pull_date = $1`,
        [today]
      );

      const pullResult = await executePull(today);

      await query(
        `UPDATE cs_daily_pull_status
         SET pull_status = $2, pull_completed_at = NOW(),
             pull_error = $3, accounts_distributed = $4
         WHERE pull_date = $1`,
        [today, pullResult.ok ? "complete" : "error", pullResult.error || null, pullResult.accountCount || 0]
      );

      return NextResponse.json({
        ok: true,
        status: pullResult.ok ? "complete" : "error",
        accountCount: pullResult.accountCount,
        error: pullResult.error,
      });
    }

    // Status check
    if (action === "status") {
      const status = await getOrCreateStatus(today);
      return NextResponse.json({ ok: true, ...status });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[daily-pull] POST error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Execute the actual PBS pull + scrub pipeline
// ═══════════════════════════════════════════════════════════════════════════════
async function executePull(today: string): Promise<{ ok: boolean; accountCount?: number; error?: string }> {
  try {
    // Import PBS pull module dynamically (only when actually running)
    const { pullPBSReport } = await import("../../../../lib/cs/pbs-pull");
    const pbsResult = await pullPBSReport();

    if (!pbsResult.ok || !pbsResult.rawData) {
      return { ok: false, error: pbsResult.error || "PBS pull returned no data" };
    }

    // Import scrub pipeline
    const { transformPBSData, filterPastDue, sortByPriority, weightedAssign, roundRobinAssign, dedup, mergeAndSort } =
      await import("../../../../lib/cs/scrub");
    const { CARRYOVER_DISPOSITIONS } = await import("../../../../lib/cs/constants");
    const { getPool } = await import("../../../../lib/db/connection");

    // Transform + filter
    const allAccounts = transformPBSData(pbsResult.rawData);
    if (allAccounts.length === 0) {
      return { ok: false, error: "No valid accounts found in PBS report" };
    }

    const { pastDue } = filterPastDue(allAccounts, today);
    const sorted = sortByPriority(pastDue);

    // Get working reps with percentages
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

    const workingReps = schedRows.rows.map((r: { name: string }) => r.name);
    if (workingReps.length === 0) {
      return { ok: false, error: "No working reps in today's schedule" };
    }

    const hasWeights = schedRows.rows.some(
      (r: { zero_pay_pct: string; non_zero_pay_pct: string }) =>
        parseFloat(r.zero_pay_pct) > 0 || parseFloat(r.non_zero_pay_pct) > 0
    );

    if (hasWeights) {
      const weights = schedRows.rows.map((r: { name: string; zero_pay_pct: string; non_zero_pay_pct: string }) => ({
        name: r.name,
        zeroPayPct: parseFloat(r.zero_pay_pct) || 0,
        nonZeroPayPct: parseFloat(r.non_zero_pay_pct) || 0,
      }));
      weightedAssign(sorted, weights);
    } else {
      roundRobinAssign(sorted, workingReps);
    }

    // Carry-overs
    const freshAccountSet = new Set(allAccounts.map(a => a.account_number));
    const prevResult = await query(
      "SELECT MAX(scrub_date) as prev_date FROM cs_past_due_accounts WHERE scrub_date < $1",
      [today]
    );
    const prevDate = prevResult.rows[0]?.prev_date;

    let carryOvers: typeof sorted = [];
    if (prevDate) {
      const cDispos = CARRYOVER_DISPOSITIONS.map((_, i) => `$${i + 2}`).join(",");
      const prevAccounts = await query(
        `SELECT * FROM cs_past_due_accounts
         WHERE scrub_date = $1
         AND LOWER(TRIM(dispo_1)) IN (${cDispos})`,
        [prevDate, ...CARRYOVER_DISPOSITIONS.map(d => d.toLowerCase())]
      );

      for (const row of prevAccounts.rows) {
        if (row.dispo_date) {
          const dd = String(row.dispo_date).slice(0, 10);
          if (dd < today) continue;
        }
        if (!freshAccountSet.has(row.account_number)) continue;

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

    // Dedup & merge
    const carryoverNums = new Set(carryOvers.map(c => c.account_number));
    const { fresh } = dedup(sorted, carryoverNums);
    const merged = mergeAndSort(carryOvers, fresh);

    // Insert into DB
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM cs_past_due_accounts WHERE scrub_date = $1", [today]);

      for (const acct of merged) {
        await client.query(
          `INSERT INTO cs_past_due_accounts
           (scrub_date, account_number, insured_name, policy_number, agent_entity,
            installments_made, next_due_date, sched_cxl_date, bill_hold, billing_method,
            amount_due, main_phone, home_phone, work_phone, customer_email, state,
            assigned_rep, dispo_1, dispo_2, dispo_date, email_sent, is_carryover)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
            acct.amount_due, acct.main_phone, acct.home_phone, acct.work_phone, acct.customer_email, acct.state,
            acct.assigned_rep, acct.dispo_1, acct.dispo_2, acct.dispo_date, acct.email_sent, acct.is_carryover,
          ]
        );
      }

      await client.query(
        `INSERT INTO cs_scrub_uploads (scrub_date, filename, raw_row_count, filtered_row_count, carryover_count, final_row_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [today, "auto-pull-pbs", allAccounts.length, pastDue.length, carryOvers.length, merged.length]
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // Send confirmation text
    const jeremyPhone = process.env.CS_MANAGER_PHONE;
    if (jeremyPhone) {
      const breakdown = workingReps.map(rep => {
        const count = merged.filter(a => a.assigned_rep === rep).length;
        return `  ${rep}: ${count}`;
      }).join("\n");

      await sendSMS(
        jeremyPhone,
        `Collections pull complete!\n\n${merged.length} accounts distributed:\n${breakdown}\n\nCarry-overs: ${carryOvers.length}`
      );
    }

    return { ok: true, accountCount: merged.length };
  } catch (e) {
    console.error("[daily-pull] executePull error:", e);
    return { ok: false, error: String(e) };
  }
}
