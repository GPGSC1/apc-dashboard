import { NextResponse } from "next/server";
import { query, getPool } from "../../../../lib/db/connection";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const date = url.searchParams.get("date");

    if (action === "schedule" && date) {
      // Get schedule for a specific date with rep info
      const result = await query(
        `SELECT r.id, r.name, r.is_active,
                COALESCE(s.is_working, true) as is_working
         FROM cs_reps r
         LEFT JOIN cs_rep_schedule s ON s.rep_id = r.id AND s.work_date = $1
         WHERE r.is_active = true
         ORDER BY r.name`,
        [date]
      );
      return NextResponse.json({ ok: true, schedule: result.rows });
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
      // repSchedule: Array<{ repId: number, isWorking: boolean }>
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        // Delete existing schedule for this date
        await client.query("DELETE FROM cs_rep_schedule WHERE work_date = $1", [date]);
        // Insert new schedule
        for (const { repId, isWorking } of repSchedule) {
          await client.query(
            "INSERT INTO cs_rep_schedule (rep_id, work_date, is_working) VALUES ($1, $2, $3)",
            [repId, date, isWorking]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      return NextResponse.json({ ok: true });
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
