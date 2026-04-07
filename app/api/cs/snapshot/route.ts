// CS Daily Snapshot — locks in today's collections metrics before the next pull
// GET: cron handler (default: snapshots today in CT)
// ?date=YYYY-MM-DD   → snapshot a specific historical date (useful for backfill)

import { NextResponse } from "next/server";
import { takeSnapshot } from "../../../../lib/cs/snapshot";

function todayCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") || todayCT();
    const snap = await takeSnapshot(date);
    console.log(
      `[cs/snapshot] ${date}: ${snap.total_accounts} accts, ${snap.collections_count} coll, $${snap.amt_collected}, ${snap.calls_dialed} calls`
    );
    return NextResponse.json({ ok: true, snapshot: snap });
  } catch (e) {
    console.error("[cs/snapshot] Error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
