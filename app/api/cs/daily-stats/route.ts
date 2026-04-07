// CS Daily Stats — Query endpoint
// GET: returns per-rep stats aggregated over a date range
// ?start=YYYY-MM-DD&end=YYYY-MM-DD (defaults to today)
// Returns both daily breakdown and totals for the range

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);

    // Default to today in CT
    const now = new Date();
    const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const todayStr = `${ct.getFullYear()}-${String(ct.getMonth() + 1).padStart(2, "0")}-${String(ct.getDate()).padStart(2, "0")}`;

    const start = url.searchParams.get("start") || todayStr;
    const end = url.searchParams.get("end") || todayStr;

    // Check if table exists
    try {
      await query("SELECT 1 FROM cs_daily_stats LIMIT 0");
    } catch {
      return NextResponse.json({ ok: true, byRep: {}, totals: {}, days: 0, message: "No stats data yet" });
    }

    // Aggregated totals by rep for the date range
    const result = await query(
      `SELECT
        rep_name,
        SUM(collections) as collections,
        SUM(zero_pays) as zero_pays,
        SUM(pif) as pif,
        SUM(chargebacks) as chargebacks,
        SUM(amt_collected) as amt_collected,
        SUM(sold) as sold,
        SUM(dp_amt_collected) as dp_amt_collected,
        SUM(total) as total,
        COUNT(DISTINCT stat_date) as days_worked
      FROM cs_daily_stats
      WHERE stat_date >= $1 AND stat_date <= $2
      GROUP BY rep_name
      ORDER BY rep_name`,
      [start, end]
    );

    // Format by rep
    const byRep: Record<string, {
      collections: number;
      zero_pays: number;
      pif: number;
      chargebacks: number;
      amt_collected: number;
      sold: number;
      dp_amt_collected: number;
      total: number;
      days_worked: number;
    }> = {};

    let totals = {
      collections: 0, zero_pays: 0, pif: 0, chargebacks: 0,
      amt_collected: 0, sold: 0, dp_amt_collected: 0, total: 0,
    };

    for (const row of result.rows) {
      const rep = row.rep_name;
      const data = {
        collections: parseInt(row.collections) || 0,
        zero_pays: parseInt(row.zero_pays) || 0,
        pif: parseInt(row.pif) || 0,
        chargebacks: parseInt(row.chargebacks) || 0,
        amt_collected: parseFloat(row.amt_collected) || 0,
        sold: parseInt(row.sold) || 0,
        dp_amt_collected: parseFloat(row.dp_amt_collected) || 0,
        total: parseInt(row.total) || 0,
        days_worked: parseInt(row.days_worked) || 0,
      };
      byRep[rep] = data;

      totals.collections += data.collections;
      totals.zero_pays += data.zero_pays;
      totals.pif += data.pif;
      totals.chargebacks += data.chargebacks;
      totals.amt_collected += data.amt_collected;
      totals.sold += data.sold;
      totals.dp_amt_collected += data.dp_amt_collected;
      totals.total += data.total;
    }

    // Count distinct days in range
    const daysResult = await query(
      "SELECT COUNT(DISTINCT stat_date) as day_count FROM cs_daily_stats WHERE stat_date >= $1 AND stat_date <= $2",
      [start, end]
    );
    const dayCount = parseInt(daysResult.rows[0]?.day_count) || 0;

    return NextResponse.json({
      ok: true,
      start,
      end,
      days: dayCount,
      byRep,
      totals,
      reps: Object.keys(byRep).sort(),
    });
  } catch (e) {
    console.error("[cs/daily-stats] Error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
