import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const weeks = parseInt(url.searchParams.get("weeks") || "4", 10);

    // Get per-rep weekly aggregates from cs_collections_log
    const result = await query(
      `SELECT
         rep_name,
         DATE_TRUNC('week', log_date)::DATE as week_start,
         SUM(collections_count) as collections_count,
         SUM(zero_pays) as zero_pays,
         SUM(amt_collected) as amt_collected,
         SUM(outbound_total) as outbound_total,
         SUM(outbound_answered) as outbound_answered,
         SUM(outbound_unanswered) as outbound_unanswered,
         SUM(inbound_total) as inbound_total,
         SUM(inbound_dropped) as inbound_dropped
       FROM cs_collections_log
       WHERE log_date >= CURRENT_DATE - ($1 * 7)
       GROUP BY rep_name, DATE_TRUNC('week', log_date)
       ORDER BY week_start DESC, rep_name`,
      [weeks]
    );

    // Also get disposition-based stats from cs_past_due_accounts
    const dispoStats = await query(
      `SELECT
         assigned_rep as rep_name,
         scrub_date,
         COUNT(*) as total_accounts,
         COUNT(CASE WHEN dispo_1 != '' AND dispo_1 IS NOT NULL THEN 1 END) as dispositioned,
         COUNT(CASE WHEN LOWER(dispo_1) = 'paid' THEN 1 END) as paid_count
       FROM cs_past_due_accounts
       WHERE scrub_date >= CURRENT_DATE - ($1 * 7)
       GROUP BY assigned_rep, scrub_date
       ORDER BY scrub_date DESC, assigned_rep`,
      [weeks]
    );

    return NextResponse.json({
      ok: true,
      weeklyStats: result.rows,
      dispoStats: dispoStats.rows,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      date,
      repName,
      collectionsCount,
      zeroPays,
      amtCollected,
      outboundTotal,
      outboundAnswered,
      outboundUnanswered,
      inboundTotal,
      inboundDropped,
    } = body;

    if (!date || !repName) {
      return NextResponse.json({ ok: false, error: "date and repName required" }, { status: 400 });
    }

    await query(
      `INSERT INTO cs_collections_log
       (log_date, rep_name, collections_count, zero_pays, amt_collected,
        outbound_total, outbound_answered, outbound_unanswered,
        inbound_total, inbound_dropped, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (log_date, rep_name) DO UPDATE SET
         collections_count = EXCLUDED.collections_count,
         zero_pays = EXCLUDED.zero_pays,
         amt_collected = EXCLUDED.amt_collected,
         outbound_total = EXCLUDED.outbound_total,
         outbound_answered = EXCLUDED.outbound_answered,
         outbound_unanswered = EXCLUDED.outbound_unanswered,
         inbound_total = EXCLUDED.inbound_total,
         inbound_dropped = EXCLUDED.inbound_dropped,
         updated_at = NOW()`,
      [
        date, repName,
        collectionsCount || 0, zeroPays || 0, amtCollected || 0,
        outboundTotal || 0, outboundAnswered || 0, outboundUnanswered || 0,
        inboundTotal || 0, inboundDropped || 0,
      ]
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
