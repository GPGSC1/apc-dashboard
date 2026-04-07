// CS Dispo Freeze cron — captures the reps' Google Sheet "Past Due" tab
// into cs_dispo_history. Scheduled at 10pm CT (last edit of the day).
// Manual: ?date=YYYY-MM-DD&freeze=0 to backfill or peek without locking.

import { NextResponse } from "next/server";
import { freezeDispoHistory } from "../../../../lib/cs/dispo-freeze";

export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") || undefined;
    const freeze = url.searchParams.get("freeze") !== "0";
    const result = await freezeDispoHistory({ scrubDate: date, freeze });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
