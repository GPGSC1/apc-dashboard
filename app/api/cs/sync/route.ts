import { NextResponse } from "next/server";
import { syncDisposFromSheet } from "../../../../lib/cs/sheets-sync";

// GET: trigger a sync from Google Sheets -> DB
// Called by cron (seed-refresh) or manually
export async function GET() {
  try {
    const result = await syncDisposFromSheet();
    console.log(`[cs/sync] Sheet sync: ${result.synced} updated, ${result.skipped} skipped, ${result.notFound} not in DB, ${result.total} total sheet rows`);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cs/sync] Error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
