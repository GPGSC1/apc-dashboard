import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

export async function GET() {
  try {
    // Check cs_outbound_calls
    const tableCheck = await query(
      `SELECT COUNT(*) as count FROM cs_outbound_calls`
    ).catch(() => ({ rows: [{ count: "TABLE DOES NOT EXIST" }] }));

    const sample = await query(
      `SELECT phone, call_date, agent_name FROM cs_outbound_calls ORDER BY call_date DESC LIMIT 10`
    ).catch(() => ({ rows: [] }));

    // Check ALL queue_calls directions
    const directions = await query(
      `SELECT direction, COUNT(*) as count FROM queue_calls GROUP BY direction`
    ).catch(() => ({ rows: [] }));

    // Check if there are any outbound-like calls in queue_calls
    const qcOutbound = await query(
      `SELECT direction, phone, queue, call_date FROM queue_calls WHERE LOWER(direction) != 'inbound' LIMIT 5`
    ).catch(() => ({ rows: [] }));

    // Check total queue_calls for today
    const todayCalls = await query(
      `SELECT COUNT(*) as count, COUNT(DISTINCT phone) as phones FROM queue_calls WHERE call_date = '2026-04-02'`
    ).catch(() => ({ rows: [{}] }));

    return NextResponse.json({
      ok: true,
      outboundTable: { count: tableCheck.rows[0].count, sample: sample.rows },
      queueCallDirections: directions.rows,
      nonInboundQueueCalls: qcOutbound.rows,
      todayQueueCalls: todayCalls.rows[0],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
