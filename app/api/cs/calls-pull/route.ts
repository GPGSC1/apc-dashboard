// CS-specific 3CX raw call pull
// Cron: every 5 minutes; gated in code to M-F 7am-7pm CT and Sat 9am-5pm CT.
// Captures EVERY call (inbound + outbound, all queues, all statuses) into
// cs_raw_calls. Account matching happens at query time, not at insert time.

import { NextResponse } from "next/server";
import { pullCsRawCalls, isCsBusinessHours } from "../../../../lib/cs/tcx-raw-pull";

export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const date = url.searchParams.get("date") || undefined;

    if (!force && !isCsBusinessHours()) {
      return NextResponse.json({ ok: true, status: "outside_business_hours" });
    }

    const result = await pullCsRawCalls(date);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
