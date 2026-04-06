// CS Calls Made — Outbound call counts per rep for a date range
import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const start = url.searchParams.get("start") || todayLocal();
    const end = url.searchParams.get("end") || todayLocal();

    const result = await query(
      `SELECT agent_name, COUNT(*) as call_count
       FROM cs_outbound_calls
       WHERE call_time >= $1::DATE
         AND call_time < ($2::DATE + 1)
         AND agent_name IS NOT NULL AND agent_name != ''
       GROUP BY agent_name
       ORDER BY agent_name`,
      [start, end]
    );

    const callsByRep: Record<string, number> = {};
    for (const row of result.rows) {
      callsByRep[row.agent_name] = parseInt(row.call_count) || 0;
    }

    return NextResponse.json({ ok: true, callsByRep, start, end });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
