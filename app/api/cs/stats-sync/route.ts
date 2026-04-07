// CS Daily Stats — Google Sheets sync endpoint
// GET: sync stats from Google Sheets into cs_daily_stats table
// ?mode=current  → sync current month only (default, for nightly cron)
// ?mode=all      → sync all configured months (initial backfill)
// ?month=2026-03 → sync a specific month

import { NextResponse } from "next/server";
import { syncAllStats, syncCurrentMonth, syncMonth, STATS_SHEETS, ensureStatsTable } from "../../../../lib/cs/stats-sync";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "current";
    const month = url.searchParams.get("month");

    if (month) {
      // Sync a specific month
      const sheetId = STATS_SHEETS[month];
      if (!sheetId) {
        return NextResponse.json({ ok: false, error: `No spreadsheet configured for ${month}` }, { status: 400 });
      }
      await ensureStatsTable();
      const result = await syncMonth(month, sheetId);
      console.log(`[cs/stats-sync] ${month}: ${result.synced} rows, ${result.days} days`);
      return NextResponse.json({ ok: true, month, ...result });
    }

    if (mode === "all") {
      const result = await syncAllStats();
      console.log(`[cs/stats-sync] All months: ${result.months} months, ${result.totalSynced} rows, ${result.totalDays} days`);
      return NextResponse.json({ ok: true, ...result });
    }

    // Default: current month only
    const result = await syncCurrentMonth();
    console.log(`[cs/stats-sync] Current month ${result.month}: ${result.synced} rows, ${result.days} days`);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cs/stats-sync] Error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
