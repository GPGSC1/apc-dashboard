import { NextResponse } from "next/server";
import { query, getPool } from "../../../../lib/db/connection";

export async function GET(request: Request) {
  try {
    // One-time migration: add percentage columns
    try {
      await query(`ALTER TABLE cs_rep_schedule ADD COLUMN IF NOT EXISTS zero_pay_pct NUMERIC DEFAULT 0`);
      await query(`ALTER TABLE cs_rep_schedule ADD COLUMN IF NOT EXISTS non_zero_pay_pct NUMERIC DEFAULT 0`);
    } catch { /* already exists */ }

    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const date = url.searchParams.get("date");

    if (action === "schedule" && date) {
      // Get schedule for a specific date with rep info
      const result = await query(
        `SELECT r.id, r.name, r.is_active,
                COALESCE(s.is_working, true) as is_working,
                COALESCE(s.zero_pay_pct, 0) as zero_pay_pct,
                COALESCE(s.non_zero_pay_pct, 0) as non_zero_pay_pct
         FROM cs_reps r
         LEFT JOIN cs_rep_schedule s ON s.rep_id = r.id AND s.work_date = $1
         WHERE r.is_active = true
         ORDER BY r.name`,
        [date]
      );

      // If no schedule exists for this date (all pcts are 0), auto-balance
      const rows = result.rows;
      const workingReps = rows.filter((r: { is_working: boolean }) => r.is_working);
      const hasAnyPct = rows.some((r: { zero_pay_pct: string }) => parseFloat(r.zero_pay_pct) > 0);

      if (!hasAnyPct && workingReps.length > 0) {
        const evenPct = Math.round((100 / workingReps.length) * 10) / 10;
        for (const row of rows) {
          if (row.is_working) {
            row.zero_pay_pct = evenPct;
            row.non_zero_pay_pct = evenPct;
          } else {
            row.zero_pay_pct = 0;
            row.non_zero_pay_pct = 0;
          }
        }
      }

      return NextResponse.json({ ok: true, schedule: rows });
    }

    // Default: list all reps
    const result = await query("SELECT id, name, is_active FROM cs_reps ORDER BY name");
    return NextResponse.json({ ok: true, reps: result.rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === "toggle_active") {
      const { repId } = body;
      await query("UPDATE cs_reps SET is_active = NOT is_active WHERE id = $1", [repId]);
      return NextResponse.json({ ok: true });
    }

    if (action === "set_schedule") {
      const { date, repSchedule } = body;
      // repSchedule: Array<{ repId: number, isWorking: boolean, zeroPayPct: number, nonZeroPayPct: number }>
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        // Delete existing schedule for this date
        await client.query("DELETE FROM cs_rep_schedule WHERE work_date = $1", [date]);
        // Insert new schedule
        for (const entry of repSchedule) {
          await client.query(
            `INSERT INTO cs_rep_schedule (rep_id, work_date, is_working, zero_pay_pct, non_zero_pay_pct)
             VALUES ($1, $2, $3, $4, $5)`,
            [entry.repId, date, entry.isWorking, entry.zeroPayPct || 0, entry.nonZeroPayPct || 0]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      // If CS_PULL_ENABLED and pull is waiting for schedule, auto-trigger it
      let pullTriggered = false;
      if (process.env.CS_PULL_ENABLED === "true") {
        try {
          const statusResult = await query(
            "SELECT pull_status FROM cs_daily_pull_status WHERE pull_date = $1",
            [date]
          );
          const pullStatus = statusResult.rows[0]?.pull_status;
          if (pullStatus === "waiting_schedule" || pullStatus === "pending") {
            // Fire-and-forget: trigger pull via internal API call
            const baseUrl = process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}`
              : "http://localhost:3000";
            fetch(`${baseUrl}/api/cs/daily-pull`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "schedule_saved" }),
            }).catch(() => {}); // fire and forget
            pullTriggered = true;
          }
        } catch {
          // daily_pull_status table may not exist yet — that's fine
        }
      }

      return NextResponse.json({ ok: true, pullTriggered });
    }

    if (action === "add_rep") {
      const { name } = body;
      if (!name?.trim()) {
        return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });
      }
      await query(
        "INSERT INTO cs_reps (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
        [name.trim()]
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
